import AbortController from 'abort-controller';
import * as assert from 'assert';
import {spawnSync} from 'child_process';
import {withDir} from 'tmp-promise';
import {installLatest, Options, prepare, UI} from '../index';

class Noop implements UI {
  constructor(readonly storagePath: string, public options: Options) {}
  executablePath: string|undefined = undefined;
  info(): void {}
  error(): void {}
  showHelp(): void {}
  promptReload(): void {}
  promptUpdate(): void {}
  promptInstall(): void {}
  async shouldReuse(path: string): Promise<boolean> { return false; }
  slow<T>(title: string, work: Promise<T>): Promise<T> { return work; }
  progress<T>(title: string, cancel: AbortController,
              work: (progress: (fraction: number) => void) => Promise<T>):
      Promise<T> {
    return work((fraction) => {});
  }
}

const arduinoCliOptions: Options = {
  // pinned version range
  versionRange: '<=v0.35.0-rc.7',
  gh: {owner: 'arduino', repo: 'arduino-cli'},
  executableName: 'arduino-cli',
  versionFlags: ['version', '--format', 'json'],
  parseVersion(output: string):
      string { return JSON.parse(output.trim()).VersionString; },
  async pickAsset(assetNames: string[]): Promise<number> {
    // console.log(assetNames[7]); // arduino-cli_0.35.0-rc.7_macOS_64bit.tar.gz
    return 7;
  }
};

withDir(async ({path: storagePath}) => {
  console.log(`temp storage path is at ${storagePath}`)
  const ui = new Noop(storagePath, arduinoCliOptions);
  const {executableName} = arduinoCliOptions;
  const {executablePath: cliPathBeforeInstall} = await prepare(ui, false);
  assert(!cliPathBeforeInstall);
  console.log(`${executableName} is not yet installed.`); // arduino-cli is not
                                                          // yet installed.

  await installLatest(ui);
  const {executablePath: cliPathAfterInstall} = await prepare(ui, false);
  assert(cliPathAfterInstall);
  console.log(`${executableName} is available: ${
      spawnSync(cliPathAfterInstall, ['version'], {encoding: 'utf8'})
          .stdout.toString()
          .trim()}`); // arduino-cli is available: arduino-cli  Version: 0.27.0
                      // Commit: c2af7c5a Date: 2022-09-05T08:10:30Z
}, {unsafeCleanup: true});
