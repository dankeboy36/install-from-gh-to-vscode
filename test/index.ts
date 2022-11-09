import {exec} from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as nodeStatic from 'node-static';
import * as os from 'os';
import * as path from 'path';
import * as semver from 'semver';
import * as tape from 'tape';
import * as tmp from 'tmp-promise';
import {promisify} from 'util';

import * as Install from '../src/index';

const oldClangd = process.cwd() + '/test/assets/fake-clangd-5/clangd';
const newClangdV15 = process.cwd() + '/test/assets/fake-clangd-15/clangd';
const newClangdV16 = process.cwd() + '/test/assets/fake-clangd-16/clangd';
const unversionedClangd =
    process.cwd() + '/test/assets/fake-clangd-unversioned/clangd';
const appleClangd = process.cwd() + '/test/assets/apple-clangd-5/clangd';
const exactLdd = process.cwd() + '/test/assets/ldd/exact';
const oldLdd = process.cwd() + '/test/assets/ldd/old';
const newLdd = process.cwd() + '/test/assets/ldd/new';
const notGlibcLdd = process.cwd() + '/test/assets/ldd/not-glibc';
const missingClangd = process.cwd() + '/test/assets/missing/clangd';
const releases = 'http://127.0.0.1:9999/release.json';
const incompatibleReleases = 'http://127.0.0.1:9999/release-incompatible.json';
const wrongUrlReleases = 'http://127.0.0.1:9999/release-wrong-url.json';
const tagRefs = 'http://127.0.0.1:9999/tag-refs.json';
const release = (version: string) =>
    `http://127.0.0.1:9999/release-${version}.json`

type ClangdInstall = Omit<typeof Install, 'prepare'|'fakeGitHubReleaseURL'>&{
  fakeLddCommand(l: string): void;
  fakeGitHubReleaseURL(arg: string|
                       ((gh: Install.GithubId, tag: string) => string)): void;
  fakeGitHubTagRefsURL(arg: string|((gh: Install.GithubId) => string)): void;
  prepare(ui: Install.UI, checkUpdate: boolean):
      Promise<{clangdPath: string | null; background: Promise<void>;}>;
  ui: FakeUI;
}
let install: ClangdInstall;
function prepareInstall(ui: FakeUI): void {
  install = {
    ui,
    fakeLddCommand: (l: string) => ui.lddCommand = l,
    prepare: async (ui, checkUpdate) => {
      const status = await Install.prepare(ui, checkUpdate);
      return { ...status, clangdPath: status.executablePath, }
    },
    checkUpdates: Install.checkUpdates,
    installLatest: Install.installLatest,
    defaultGithubReleaseURL: Install.defaultGithubReleaseURL,
    fakeGitHubReleaseURL:
        (arg: string|((gh: Install.GithubId, tag: string) => string)) =>
            Install.fakeGitHubReleaseURL(typeof arg === 'function' ? arg
                                                                   : () => arg),
    fakeGitHubTagRefsURL: (arg: string|((gh: Install.GithubId) => string)) =>
        Install.fakeGitHubTagRefsURL(typeof arg === 'function' ? arg
                                                               : () => arg),
  }
}

// From
// https://github.com/clangd/node-clangd/blob/2ccb3395391004aee1349df47f44be190289382e/src/index.ts#L355-L371
// Detect the (linux) system's glibc version. If older than `min`, return it.
async function execOldGlibc(min: semver.Range): Promise<semver.Range|null> {
  // ldd is distributed with glibc, so ldd --version should be a good proxy.
  const {stdout: output} =
      await promisify(exec)(`${install.ui.lddCommand} --version`);
  // The first line is e.g. "ldd (Debian GLIBC 2.29-9) 2.29".
  const line = output.split('\n', 1)[0];
  // Require some confirmation this is [e]glibc, and a plausible
  // version number.
  const match = line.match(/^ldd .*glibc.* (\d+(?:\.\d+)+)[^ ]*$/i);
  if (!match || !semver.validRange(match[1], true)) {
    console.error(`Can't glibc version from ldd --version output: ${line}`);
    return null;
  }
  const version = new semver.Range(match[1], true);
  console.log('glibc is', version.raw, 'min is', min.raw);
  return semver.gtr(semver.minVersion(min), version) ? version : null;
}

const clangdOptions: Install.Options = {
  executableName: 'clangd',
  versionFlags: ['--version'],
  parseVersion(output: string): string {
    const prefix = 'clangd version ';
    const pos = output.indexOf(prefix);
    if (pos < 0)
      throw new Error(`Couldn't parse clangd --version output: ${output}`);
    if (pos > 0) {
      const vendor = output.substring(0, pos).trim();
      if (vendor == 'Apple')
        throw new Error(`Cannot compare vendor's clangd version: ${output}`);
    }
    // Some vendors add trailing ~patchlevel, ignore this.
    const rawVersion = output.substr(pos + prefix.length).split(/\s|~/, 1)[0];
    return rawVersion;
  },
  gh: {owner: 'clangd', repo: 'clangd'},
  async pickAsset(assetNames: string[]): Promise<number> {
    const platform = os.platform();
    const arch = os.arch();
    const variants: {[key: string]: string} = {
      'win32': 'windows',
      'linux': 'linux',
      'darwin': 'mac',
    };
    const variant = variants[platform];
    if (variant == 'linux') {
      // Hardcoding this here is sad, but we'd like to offer a nice error
      // message without making the user download the package first.
      const minGlibc = new semver.Range('2.18');
      const oldGlibc = await execOldGlibc(minGlibc);
      if (oldGlibc) {
        throw new Error(
            'The clangd release is not compatible with your system ' +
            `(glibc ${oldGlibc.raw} < ${minGlibc.raw}). ` +
            'Try to install it using your package manager instead.');
      }
    }
    // 32-bit vscode is still common on 64-bit windows, so don't reject that.
    if (variant && (arch == 'x64' || variant == 'windows' ||
                    // Mac distribution contains a fat binary working on both
                    // x64 and arm64s.
                    (arch == 'arm64' && variant == 'mac'))) {
      const substr = 'clangd-' + variant;
      const index = assetNames.findIndex(name => name.indexOf(substr) >= 0);
      return index;
    }
    return -1;
  },
}

// A fake editor that records interactions.
class FakeUI implements Install.UI {
  constructor(public readonly storagePath: string) {
    console.log('Storage is', this.storagePath);
    prepareInstall(this);
  }
  readonly events: string[] = [];
  private event(s: string) {
    console.log(s);
    this.events.push(s);
  }

  _clangdPath = oldClangd;

  info(s: string) {
    this.event('info');
    console.log(s);
  }
  error(s: string) {
    this.event('error');
    console.error(s);
  }
  showHelp(msg: string, url: string) {
    this.event('showHelp');
    console.info(msg, url);
  }

  promptReload() { this.event('promptReload'); }
  promptUpdate() { this.event('promptUpdate'); }
  promptInstall() { this.event('promptInstall'); }
  public shouldReuseValue = true;
  async shouldReuse() {
    this.event('shouldReuse');
    return this.shouldReuseValue;
  }

  slow<T>(_title: string, work: Promise<T>) {
    this.event('slow');
    return work;
  }
  progress<T>(_title: string, _cancel: any,
              work: (progress: (fraction: number) => void) => Promise<T>) {
    this.event('progress');
    return work((fraction) => console.log('progress% ', 100 * fraction));
  }

  options = clangdOptions;
  installURL = 'https://clangd.llvm.org/installation.html';
  lddCommand = 'ldd';
  _executablePath = this.clangdPath;
  get executablePath(): string { return this._executablePath; }
  set executablePath(p: string) {
    this._executablePath = p;
    this._clangdPath = p;
  }
  get clangdPath(): string { return this._clangdPath; }
  set clangdPath(p: string) {
    this._clangdPath = p;
    this._executablePath = p;
  }
};

function test(name: string,
              body: (assert: tape.Test, ui: FakeUI) => Promise<any>) {
  tape(name, async (assert) => tmp.withDir(async dir => {
    const ui = new FakeUI(dir.path);
    const files = new nodeStatic.Server('test/assets/');
    return new Promise((resolve, _reject) => {
      const server = http.createServer((req, res) => {
                           console.log('Fake github:', req.method, req.url);
                           req.on('end', () => files.serve(req, res)).resume();
                         })
                         .listen(9999, '::', async () => {
                           console.log('Fake github serving...');
                           install.fakeGitHubReleaseURL(releases);
                           install.fakeLddCommand(exactLdd);
                           try {
                             await body(assert, ui);
                           } catch (e) {
                             assert.fail(e);
                           }
                           console.log('Fake github stopping...');
                           server.close();
                           resolve();
                         });
    });
  }, {unsafeCleanup: true}));
}

// Test the actual installation, typically the clangd.install command.

test('install', async (assert, ui) => {
  await install.installLatest(ui);

  const installedClangd =
      path.join(ui.storagePath, 'install', '10.0', 'fake-clangd-10', 'clangd');
  assert.true(fs.existsSync(installedClangd),
              `Extracted clangd exists: ${installedClangd}`);
  assert.equal(ui.clangdPath, installedClangd);
  assert.deepEqual(
      ui.events, [/*download*/ 'progress', /*extract*/ 'slow', 'promptReload']);
});

test('install: no binary for platform', async (assert, ui) => {
  install.fakeGitHubReleaseURL(incompatibleReleases);
  await install.installLatest(ui);

  const installedClangd =
      path.join(ui.storagePath, 'install', '10.0', 'fake-clangd-10', 'clangd');
  assert.false(fs.existsSync(installedClangd),
               `Extracted clangd exists: ${installedClangd}`);
  assert.true(ui.clangdPath.endsWith('fake-clangd-5/clangd'),
              'clangdPath unmodified');
  assert.deepEqual(ui.events, ['showHelp']);
});

test('install: wrong url', async (assert, ui) => {
  install.fakeGitHubReleaseURL(wrongUrlReleases);
  await install.installLatest(ui);

  const installedClangd =
      path.join(ui.storagePath, 'install', '10.0', 'fake-clangd-10', 'clangd');
  assert.false(fs.existsSync(installedClangd),
               `Extracted clangd exists: ${installedClangd}`);
  assert.true(ui.clangdPath.endsWith('fake-clangd-5/clangd'),
              'clangdPath unmodified');
  assert.deepEqual(ui.events,
                   [/*download*/ 'progress', /*download-fails*/ 'showHelp']);
});

if (os.platform() == 'linux') {
  test('install: new glibc', async (assert, ui) => {
    install.fakeLddCommand(newLdd);
    await install.installLatest(ui);

    assert.deepEqual(ui.events, ['progress', 'slow', 'promptReload']);
  });

  test('install: old glibc', async (assert, ui) => {
    install.fakeLddCommand(oldLdd);
    await install.installLatest(ui);

    assert.deepEqual(ui.events, ['showHelp'], 'not installed due to old glibc');
  });

  test('install: unknown glibc', async (assert, ui) => {
    install.fakeLddCommand(notGlibcLdd);
    await install.installLatest(ui);

    // Installed. It may not work, but also maybe our detection just failed.
    assert.deepEqual(ui.events, ['progress', 'slow', 'promptReload']);
  });
}

test('install: reuse existing install', async (assert, ui) => {
  const existing = path.join(ui.storagePath, 'install', '10.0', 'weird-dir');
  await fs.promises.mkdir(existing, {recursive: true});
  const existingClangd = path.join(existing, 'clangd');
  await fs.promises.writeFile(existingClangd, '');

  ui.shouldReuseValue = true;
  await install.installLatest(ui);

  const installedClangd =
      path.join(ui.storagePath, 'install', '10.0', 'fake-clangd-10', 'clangd');
  assert.false(fs.existsSync(installedClangd), 'Not extracted');
  assert.true(fs.existsSync(existingClangd), 'Not erased');
  assert.equal(existingClangd, ui.clangdPath, 'clangdPath is existing install');
  assert.deepEqual(ui.events, ['shouldReuse', 'promptReload']);
});

test('install: overwrite existing install', async (assert, ui) => {
  const existing = path.join(ui.storagePath, 'install', '10.0', 'weird-dir');
  await fs.promises.mkdir(existing, {recursive: true});
  const existingClangd = path.join(existing, 'clangd');
  await fs.promises.writeFile(existingClangd, '');

  ui.shouldReuseValue = false;
  await install.installLatest(ui);

  const installedClangd =
      path.join(ui.storagePath, 'install', '10.0', 'fake-clangd-10', 'clangd');
  assert.true(fs.existsSync(installedClangd), 'Extracted');
  assert.false(fs.existsSync(existingClangd), 'Erased');
  assert.equal(installedClangd, ui.clangdPath, 'clangdPath is new install');
  assert.deepEqual(ui.events, [
    'shouldReuse', /*download*/ 'progress', /*extract*/ 'slow', 'promptReload'
  ]);
});

// Test the update check, typically the clangd.update command.
// This doesn't actually install anything (editors must call install()).

test('update: from 5 to 10', async (assert, ui) => {
  ui.clangdPath = oldClangd;
  await install.checkUpdates(true, ui);

  assert.deepEqual(ui.events, ['promptUpdate']);
});

test('update: from 15 to 10', async (assert, ui) => {
  ui.clangdPath = newClangdV15;
  await install.checkUpdates(true, ui);

  assert.deepEqual(ui.events, [/*up-to-date*/ 'info']);
});

test('update: from 16 to 10', async (assert, ui) => {
  ui.clangdPath = newClangdV16;
  await install.checkUpdates(true, ui);

  assert.deepEqual(ui.events, [/*up-to-date*/ 'info']);
});

test('update: from apple to 10', async (assert, ui) => {
  ui.clangdPath = appleClangd;
  await install.checkUpdates(true, ui);

  assert.deepEqual(ui.events, [/*cant-compare*/ 'error']);
});

// Test the generic on-startup flow which:
//   - locates configured clangd if available
//   - suggests installing it if missing, and checks for updates if present
// This handles lots of permutations but never installs anything, either.

test('prepare: no clangd installed', async (assert, ui) => {
  ui.clangdPath = missingClangd;
  const status = await install.prepare(ui, true);
  await status.background;

  assert.equal(status.clangdPath, null);
  assert.deepEqual(ui.events, ['promptInstall']);
});

test('prepare: not installed, unavailable', async (assert, ui) => {
  ui.clangdPath = missingClangd;
  install.fakeGitHubReleaseURL(incompatibleReleases);
  const status = await install.prepare(ui, true);
  await status.background;

  assert.equal(status.clangdPath, null);
  assert.deepEqual(ui.events, ['showHelp']);
});

test('prepare: old clangd installed', async (assert, ui) => {
  ui.clangdPath = oldClangd;
  const status = await install.prepare(ui, true);
  await status.background;

  assert.equal(status.clangdPath, oldClangd);
  assert.deepEqual(ui.events, ['promptUpdate']);
});

test('prepare: updates disabled', async (assert, ui) => {
  ui.clangdPath = oldClangd;
  const status = await install.prepare(ui, false);
  await status.background;

  assert.equal(status.clangdPath, oldClangd);
  assert.deepEqual(ui.events, []);
});

test('prepare: old clangd installed, new unavailable', async (assert, ui) => {
  ui.clangdPath = oldClangd;
  install.fakeGitHubReleaseURL(incompatibleReleases);
  const status = await install.prepare(ui, true);
  await status.background;

  assert.equal(status.clangdPath, oldClangd);
  assert.deepEqual(ui.events, []);
});

test('prepare: new clangd installed', async (assert, ui) => {
  ui.clangdPath = newClangdV15;
  const status = await install.prepare(ui, true);
  await status.background;

  assert.deepEqual(ui.events, []); // unsolicited, so no "up-to-date" message.
});

test('prepare: unversioned clangd installed', async (assert, ui) => {
  ui.clangdPath = unversionedClangd;
  const status = await install.prepare(ui, true);
  await status.background;
  // We assume any custom-installed clangd is desired.
  assert.deepEqual(ui.events, []);
});

// downstream tests. mainly for checking the version range handling and not the
// download/install lifecycle.

test('install version range', async (assert, ui) => {
  ui.options.versionRange = '<=14.0.0';
  install.fakeGitHubTagRefsURL(tagRefs);
  install.fakeGitHubReleaseURL((_, tag) => {
    assert.equal(tag, '14.0.0');
    return release(tag);
  });
  await install.installLatest(ui);

  const installedClangd = path.join(ui.storagePath, 'install', '14.0.0',
                                    'fake-clangd-14', 'clangd');
  assert.true(fs.existsSync(installedClangd),
              `Extracted clangd exists: ${installedClangd}`);
  assert.equal(ui.clangdPath, installedClangd);
  assert.deepEqual(
      ui.events, [/*download*/ 'progress', /*extract*/ 'slow', 'promptReload']);
});

test('install version range: no match', async (assert, ui) => {
  ui.options.versionRange = '>14.0.3 <15.0.0';
  install.fakeGitHubTagRefsURL(tagRefs);
  install.fakeGitHubReleaseURL(() => {
    const message =
        `Unexpected release retch by tag. No version should match the ${
            ui.options.versionRange}.`;
    assert.fail(message);
    throw new Error(message);
  });
  await install.installLatest(ui);

  const downloadRoot = path.join(ui.storagePath, 'download');
  assert.false(fs.existsSync(downloadRoot),
               `Download folder exists: ${downloadRoot}`);
  const installRoot = path.join(ui.storagePath, 'install');
  assert.false(fs.existsSync(installRoot),
               `Install folder exists: ${installRoot}`);
  assert.true(ui.clangdPath.endsWith('fake-clangd-5/clangd'),
              'clangdPath unmodified');
  assert.deepEqual(ui.events, ['showHelp']);
});
