// Automatically downloads an executable from a GitHub release.
//
// This lib was forked from
// [`node-clangd`](https://github.com/clangd/node-clangd) to ensure the
// existence of various binaries in VS Code. I love how the clangd people
// implemented it for VS Code, and I wanted to generalize it. The `coc-clangd`
// is unmaintained although it might work.
//
//
//
// There are several entry points:
//  - installation explicitly requested
//  - checking for updates (manual or automatic)
//  - no usable executable found, try to recover
// These have different flows, but the same underlying mechanisms.
import {AbortController} from 'abort-controller';
import * as child_process from 'child_process';
import * as decompress from 'decompress';
import * as fs from 'fs';
import fetch from 'node-fetch';
import * as os from 'os';
import * as path from 'path';
import * as readdirp from 'readdirp';
import * as rimraf from 'rimraf';
import * as semver from 'semver';
import * as stream from 'stream';
import {promisify} from 'util';
import * as which from 'which';

const targz = require('decompress-targz');
const unzip = require('decompress-unzip');

// Owner and the repository to find the releases on GitHub or the URL.
export type GithubId = {
  owner: string; repo: string;
};

export type Options = {
  // If defined, the most recent compatible version of the executable will be
  // downloaded instead of the latest one.
  // For the spec how semver ranges work, please reference the
  // [`node-semver`](https://github.com/npm/node-semver#ranges) documentation.
  versionRange?: string;
  // The name of the executable without the extension if on Windows. For
  // example, `clangd`. The value is used in the UI for interacting with the
  // user but also to get the version number of the binary.
  executableName: string;
  // The executable will be invoked with these flags get the version number.
  versionFlags: string[];
  // Parse version number output and return with a loose (see `node-semver
  // --loose`) version number for semver comparison. `undefined` if cannot
  // parse.
  parseVersion(output: string): string | undefined;
  // The to identify the GitHub release for the download.
  gh: GithubId;
  // For picking an asset from the available ones based on the platform and
  // arch. Should return with the index of the `assets`.
  pickAsset(assetNames: string[]): Promise<number>;
}

// Abstracts the editor UI and configuration.
// This allows the core installation flows to be shared across editors, by
// implementing a UI class for each.
export type UI = {
  // Root where we should placed downloaded/installed files.
  readonly storagePath: string;
  // The configured executable location. Could be missing.
  executablePath: string | undefined;
  // Config for the UI.
  options: Options;
  // Show a generic message to the user.
  info(s: string): void;
  // Show a generic error message to the user.
  error(s: string): void;
  // Show a message and direct the user to a website.
  showHelp(message: string, url?: string): void;
  // Optional URL to the public site with the manual installation steps.
  installURL?: string;

  // Ask the user to reload the plugin.
  promptReload(message: string): void;
  // Ask the user to run installLatest() to upgrade the executable.
  promptUpdate(oldVersion: string, newVersion: string): void;
  // Ask the user to run installLatest() to install the missing executable.
  promptInstall(version: string): void;
  // Ask whether to reuse rather than overwrite the existing executable
  // installation.
  // Undefined means no choice was made, so we shouldn't do either.
  shouldReuse(path: string): Promise<boolean|undefined>;

  // `work` may take a while to resolve, indicate we're doing something.
  slow<T>(title: string, work: Promise<T>): Promise<T>;
  // `work` will take a while to run and can indicate fractional progress.
  progress<T>(title: string, cancel: AbortController|null,
              work: (progress: (fraction: number) => void) => Promise<T>):
      Promise<T>;
}

type InstallStatus = {
  // Absolute path to the executable, or null if no valid executable is
  // configured.
  executablePath: string|null;
  // Background tasks that were started, exposed for testing.
  background: Promise<void>;
};

// Main startup workflow: check whether the configured executable us usable.
// If not, offer to install one. If so, check for updates.
export async function prepare(ui: UI,
                              checkUpdate: boolean): Promise<InstallStatus> {
  let executablePath = ui.executablePath;
  try {
    if (path.isAbsolute(executablePath)) {
      await promisify(fs.access)(executablePath);
    } else {
      executablePath = await promisify(which)(executablePath) as string;
    }
  } catch (e) {
    // Couldn't find the executable - start recovery flow and stop extension
    // loading.
    return {executablePath: null, background: recover(ui)};
  }
  // Allow extension to load, asynchronously check for updates.
  return {
    executablePath: executablePath,
    background: checkUpdate ? checkUpdates(/*requested=*/ false, ui)
                            : Promise.resolve()
  };
}

// The user has explicitly asked to install the latest available executable
// version from GitHub. Do so without further prompting, or report an error.
export async function installLatest(ui: UI) {
  const abort = new AbortController();
  const {options: {executableName, pickAsset: chooseAsset}} = ui;
  try {
    const release = await Github.latestRelease(ui);
    const asset =
        await Github.chooseAsset(release, executableName, chooseAsset);
    ui.executablePath = await Install.install(release, asset, abort, ui);
    ui.promptReload(`${executableName} ${release.name} is now installed.`);
  } catch (e) {
    if (!abort.signal.aborted) {
      console.error(`Failed to install ${executableName}: `, e);
      const message =
          `Failed to install ${executableName}: ${e}` +
          `${ui.installURL ? '\nYou may want to install it manually.' : ''}`;
      ui.showHelp(message, ui.installURL);
    }
  }
}

// We have an apparently-valid executable, check for updates.
export async function checkUpdates(requested: boolean, ui: UI) {
  // Gather all the version information to see if there's an upgrade.
  const {
    options:
        {executableName, pickAsset: chooseAsset, versionFlags, parseVersion},
    executablePath,
  } = ui;
  try {
    var release = await Github.latestRelease(ui);
    await Github.chooseAsset(release, executableName,
                             chooseAsset); // Ensure a binary for this platform.
    var upgrade = await Version.upgrade(release, executablePath, versionFlags,
                                        parseVersion);
  } catch (e) {
    console.log(`Failed to check for ${executableName} update: `, e);
    // We're not sure whether there's an upgrade: stay quiet unless asked.
    if (requested)
      ui.error(`Failed to check for ${executableName} update: ${e}`);
    return;
  }
  console.log(`Checking for ${executableName} update: available=`, upgrade.new,
              ' installed=', upgrade.old);
  // Bail out if the new version is better or comparable.
  if (!upgrade.upgrade) {
    if (requested)
      ui.info(`${executableName} is up-to-date (you have ${
          upgrade.old}, latest is ${upgrade.new})`);
    return;
  }
  ui.promptUpdate(upgrade.old, upgrade.new);
}

// The extension has detected executable isn't available.
// Inform the user, and if possible offer to install or adjust the path.
// Unlike installLatest(), we've had no explicit user request or consent yet.
async function recover(ui: UI) {
  const {options: {executableName, pickAsset: chooseAsset}} = ui;
  try {
    const release = await Github.latestRelease(ui);
    await Github.chooseAsset(release, executableName,
                             chooseAsset); // Ensure a binary for this platform.
    ui.promptInstall(release.name);
  } catch (e) {
    console.error('Auto-install failed: ', e);
    ui.showHelp(`The ${executableName} is not installed.`, ui.installURL);
  }
}

export const defaultGithubReleaseURL: (gh: GithubId, tag: string|null) =>
    string = (gh, tag): string => {
      // Get release by tag name if specified:
      // https://api.github.com/repos/OWNER/REPO/releases/tags/TAG
      // (https://docs.github.com/en/rest/releases/releases#get-a-release-by-tag-name)
      // Otherwise, get the latest release.
      return `https://api.github.com/repos/${gh.owner}/${gh.repo}/releases/${
          tag ? `tags/${tag}` : 'latest'}`;
    };
let githubReleaseURL = defaultGithubReleaseURL;

// Set a fake URL for testing.
export function fakeGitHubReleaseURL(u: typeof githubReleaseURL) {
  githubReleaseURL = u;
}

const defaultGithubTagRefsURL: (gh: GithubId) => string = (gh): string => {
  return `https://api.github.com/repos/${gh.owner}/${
      gh.repo}/git/matching-refs/tags`
};
let githubTagRefsURL = defaultGithubTagRefsURL;

// Set a fake tag refs URL for testing.
export function fakeGitHubTagRefsURL(u: typeof githubTagRefsURL) {
  githubTagRefsURL = u;
}

// Bits for talking to github's release API
namespace Github {
export interface Release {
  name: string, tag_name: string, assets: Array<Asset>,
}
export interface Asset {
  name: string, browser_download_url: string,
}
// This is not the response of https://api.github.com/repos/OWNER/REPO/tags
// (https://docs.github.com/en/rest/repos/repos#list-repository-tags) because
// the response processing requires pagination
// (https://docs.github.com/en/rest/guides/traversing-with-pagination).
// The https://api.github.com/repos/OWNER/REPO/git/matching-refs/REF response
// contains all refs. Here, :REF is tags
// (https://docs.github.com/en/rest/git/refs#list-matching-references).
interface TagRef {
  // For example refs/tags/0.1.22
  ref: string;
}

// TODO curl
// https://api.github.com/repos/arduino/arduino-cli/git/matching-refs/tags to
// get all tags -> find highest version in range, get release Fetch the
// metadata for the latest stable executable release.
export async function latestRelease(ui: UI): Promise<Release> {
  const version = await latestCompatibleVersion(ui);
  const response =
      await fetch(githubReleaseURL(ui.options.gh, version),
                  {headers: {'Accept': 'application/vnd.github+json'}});
  if (!response.ok) {
    console.log(response.url, response.status, response.statusText);
    throw new Error(`Can't fetch release: ${response.statusText}`);
  }
  return await response.json() as Release;
}

async function latestCompatibleVersion(ui: UI): Promise<string|undefined> {
  const {versionRange, executableName} = ui.options;
  if (!versionRange) {
    return undefined;
  }
  if (!semver.validRange(versionRange)) {
    throw new Error(`Invalid version range: ${versionRange}.`);
  }
  const versionConstrains = new semver.Range(versionRange, true);
  const refs = await tagRefs(ui);
  const tags = refs.map(toSemver)
                   .filter(semver => Boolean(semver))
                   .sort(semver.compare)
                   .reverse();
  for (const tag of tags) {
    if (versionConstrains.test(tag)) {
      return tag.version;
    }
  }
  throw new Error(`Could not find a compatible version for ${
      executableName}. Expected ${versionRange}.`);
}

function tag(tagRef: TagRef): string {
  return tagRef.ref.substring('refs/tags/'.length);
}

function toSemver(tagRef: TagRef): semver.SemVer|undefined {
  const maybeSemver = tag(tagRef);
  if (semver.valid(maybeSemver)) {
    return new semver.SemVer(maybeSemver, true);
  }
  return undefined;
}

async function tagRefs(ui: UI): Promise<TagRef[]> {
  const response =
      await fetch(githubTagRefsURL(ui.options.gh),
                  {headers: {'Accept': 'application/vnd.github+json'}});
  if (!response.ok) {
    console.log(response.url, response.status, response.statusText);
    throw new Error(`Can't fetch tag refs: ${response.statusText}`);
  }
  return await response.json() as TagRef[];
}

// Determine which release asset should be installed for this machine.
export async function chooseAsset(release: Github.Release,
                                  executableName: string,
                                  chooseAsset: UI['options']['pickAsset']):
    Promise<Github.Asset> {
  ;
  const index = await chooseAsset(release.assets.map(({name}) => name));
  const asset = release.assets[index];
  if (asset)
    return asset;
  throw new Error(`No ${executableName} ${release.name} binary available for ${
      os.platform()}/${os.arch()}`);
}
}

// Functions to download and install the releases, and manage the files on disk.
//
// File layout:
//  <ui.storagePath>/
//    install/
//      <version>/
//        clangd_<version>/            (outer director from zip file)
//          bin/clangd
//          lib/clang/...
//    download/
//      clangd-platform-<version>.zip  (deleted after extraction)
namespace Install {
// Download the binary archive `asset` from a github `release` and extract it
// to the extension's global storage location.
// The `abort` controller is signaled if the user cancels the installation.
// Returns the absolute path to the installed clangd executable.
export async function install(release: Github.Release, asset: Github.Asset,
                              abort: AbortController, ui: UI): Promise<string> {
  const dirs = await createDirs(ui);
  const extractRoot = path.join(dirs.install, release.tag_name);
  const {options: {executableName}} = ui;
  if (await promisify(fs.exists)(extractRoot)) {
    const reuse = await ui.shouldReuse(release.name);
    if (reuse === undefined) {
      // User dismissed prompt, bail out.
      abort.abort();
      throw new Error(`${executableName} ${release.name} already installed!`);
    }
    if (reuse) {
      // Find the executable within the existing directory.
      let files = (await readdirp.promise(extractRoot)).map(e => e.fullPath);
      return findExecutable(executableName, files);
    } else {
      // Delete the old version.
      await promisify(rimraf)(extractRoot);
      // continue with installation.
    }
  }
  const archiveFile = path.join(dirs.download, asset.name);
  await download(asset.browser_download_url, archiveFile, abort, ui);
  const files = await ui.slow(`Extracting ${asset.name}`,
                              unarchive(archiveFile, extractRoot));
  const executable =
      findExecutable(executableName, files.files.map(f => f.path));
  const executablePath = path.join(extractRoot, executable);
  await fs.promises.chmod(executablePath, 0o755);
  await fs.promises.unlink(archiveFile);
  return executablePath;
}

async function unarchive(archiveFile: string, extractRoot: string):
    Promise<{files: decompress.File[]}> {
  const files =
      await decompress(archiveFile, extractRoot, {plugins: [unzip(), targz()]});
  return {files};
}

// Create the 'install' and 'download' directories, and return absolute paths.
async function createDirs(ui: UI) {
  const install = path.join(ui.storagePath, 'install');
  const download = path.join(ui.storagePath, 'download');
  for (const dir of [install, download])
    await fs.promises.mkdir(dir, {'recursive': true});
  return {install: install, download: download};
}

// Find the executable within a set of files.
function findExecutable(executableName: string, paths: string[]): string {
  const filename =
      os.platform() == 'win32' ? `${executableName}.exe` : executableName;
  const entry = paths.find(f => path.posix.basename(f) == filename ||
                                path.win32.basename(f) == filename);
  if (entry == null)
    throw new Error(`Didn't find a ${executableName} executable!`);
  return entry;
}

// Downloads `url` to a local file `dest` (whose parent should exist).
// A progress dialog is shown, if it is cancelled then `abort` is signaled.
async function download(url: string, dest: string, abort: AbortController,
                        ui: UI): Promise<void> {
  console.log('Downloading ', url, ' to ', dest);
  return ui.progress(
      `Downloading ${path.basename(dest)}`, abort, async (progress) => {
        const response = await fetch(url, {signal: abort.signal});
        if (!response.ok)
          throw new Error(`Failed to download ${url}`);
        const size = Number(response.headers.get('content-length'));
        let read = 0;
        response.body.on('data', (chunk: Buffer) => {
          read += chunk.length;
          progress(read / size);
        });
        const out = fs.createWriteStream(dest);
        await promisify(stream.pipeline)(response.body, out).catch(e => {
          // Clean up the partial file if the download failed.
          fs.unlink(dest, (_) => null); // Don't wait, and ignore error.
          throw e;
        });
      });
}
}

// Functions dealing with the executable versions.
//
// We parse both github release numbers and the version number generated from
// the installed executable by treating them as SemVer ranges, and offer an
// upgrade if the version is unambiguously newer.
//
// These functions throw if versions can't be parsed (e.g. `installed clangd`
// is a vendor-modified version).
namespace Version {
export async function upgrade(release: Github.Release, executablePath: string,
                              versionFlags: string[],
                              parseVersion: UI['options']['parseVersion']) {
  const releasedVer = released(release);
  const installedVer =
      await installed(executablePath, versionFlags, parseVersion);
  return {
    old: installedVer.raw,
    new: releasedVer.raw,
    upgrade: rangeGreater(releasedVer, installedVer)
  };
}

const loose: semver.Options = {
  'loose': true
};

// Get the version of an installed executable by running a system command and
// parsing the output.
async function installed(executablePath: string, flags: string[],
                         parse: (output: string) => string | undefined):
    Promise<semver.Range> {
  run
  const output = await run(executablePath, flags);
  console.log(executablePath, ` ${flags.join(' ')} output: `, output);
  const rawVersion = parse(output);
  return new semver.Range(rawVersion, loose);
}

// Get the version of a github release, by parsing the tag or name.
function released(release: Github.Release): semver.Range {
  // Prefer the tag name, but fall back to the release name.
  return (!semver.validRange(release.tag_name, loose) &&
          semver.validRange(release.name, loose))
             ? new semver.Range(release.name, loose)
             : new semver.Range(release.tag_name, loose);
}

// Run a system command and capture any stdout produced.
async function run(command: string, flags: string[]): Promise<string> {
  const child = child_process.spawn(command, flags,
                                    {stdio: ['ignore', 'pipe', 'ignore']});
  let output = '';
  for await (const chunk of child.stdout)
    output += chunk;
  return output;
}

function rangeGreater(newVer: semver.Range, oldVer: semver.Range) {
  return semver.gtr(semver.minVersion(newVer), oldVer);
}
}
