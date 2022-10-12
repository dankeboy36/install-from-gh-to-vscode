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
  gh: {owner: 'arduino', repo: 'arduino-cli'},
  executableName: 'arduino-cli',
  versionFlags: ['version', '--format', 'json'],
  parseVersion(output: string):
      string { return JSON.parse(output.trim()).VersionString; },
  async chooseAsset(platform: NodeJS.Platform, arch: string,
                    assetNames: string[]): Promise<number> {
    return 6; // 'arduino-cli_0.27.1_macOS_64bit.tar.gz'
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
          .trim()}`); // arduino-cli is available: arduino-cli
                      // Version: 0.27.1 Commit: a900cfb2 Date:
                      // 2022-09-06T16:44:27Z
}, {unsafeCleanup: true});
