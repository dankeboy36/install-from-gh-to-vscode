import AbortController from 'abort-controller';
import * as assert from 'assert';
import {dir} from 'tmp-promise';
import {installLatest, Options, prepare, UI} from './index';

class Noop implements UI {
  constructor(readonly storagePath: string, public options: Options) {}
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
                    assetsName: string[]): Promise<number> {
    return 1; // 'arduino-cli_0.27.1_Linux_32bit.tar.gz'
  }
};

(async () => {
  const {cleanup, path: storagePath} =
      await dir({unsafeCleanup: true, keep: false});
  console.log(`temp storage path is at ${storagePath}`)
  try {
    const ui = new Noop(storagePath, arduinoCliOptions);
    const {executablePath: cliPathBeforeInstall} = await prepare(ui, false);
    assert(!cliPathBeforeInstall);
    console.log('arduino-cli is not yet installed.');

    await installLatest(ui);
    const {executablePath: cliPathAfterInstall} = await prepare(ui, false);
    assert(cliPathAfterInstall);
  } finally {
    await cleanup();
  }
})();