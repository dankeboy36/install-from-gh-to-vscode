// Automatically install an executable releases from GitHub.
// This wraps `./install` in the VSCode UI. See that package for more.

import AbortController from 'abort-controller';
import * as path from 'path';
import * as vscode from 'vscode';
import * as common from './index';

// Returns the executable path to be used, or null if the executable is not
// installed.
export async function activate(context: vscode.ExtensionContext,
                               options: common.Options): Promise<string> {
  const cfg = vscode.workspace.getConfiguration(options.executableName);
  const {executableName} = options;
  const ui = new UI(options, context, cfg);
  context.subscriptions.push(vscode.commands.registerCommand(
      `${executableName}.install`, async () => common.installLatest(ui)));
  context.subscriptions.push(vscode.commands.registerCommand(
      `${executableName}.update`, async () => common.checkUpdates(true, ui)));
  const status = await common.prepare(ui, cfg.get<boolean>('checkUpdates'));
  return status.executablePath;
}

class UI implements common.UI {
  constructor(public options: common.Options,
              private context: vscode.ExtensionContext,
              private config: vscode.WorkspaceConfiguration) {}

  get storagePath(): string { return this.context.globalStoragePath; }
  async choose(prompt: string, options: string[]): Promise<string|undefined> {
    return await vscode.window.showInformationMessage(prompt, ...options);
  }
  slow<T>(title: string, result: Promise<T>) {
    const opts = {
      location: vscode.ProgressLocation.Notification,
      title: title,
      cancellable: false,
    };
    return Promise.resolve(vscode.window.withProgress(opts, () => result));
  }
  progress<T>(title: string, cancel: AbortController|null,
              body: (progress: (fraction: number) => void) => Promise<T>) {
    const opts = {
      location: vscode.ProgressLocation.Notification,
      title: title,
      cancellable: cancel != null,
    };
    const result = vscode.window.withProgress(opts, async (progress, canc) => {
      if (cancel)
        canc.onCancellationRequested((_) => cancel.abort());
      let lastFraction = 0;
      return body(fraction => {
        if (fraction > lastFraction) {
          progress.report({increment: 100 * (fraction - lastFraction)});
          lastFraction = fraction;
        }
      });
    });
    return Promise.resolve(result); // Thenable to real promise.
  }
  error(s: string) { vscode.window.showErrorMessage(s); }
  info(s: string) { vscode.window.showInformationMessage(s); }
  command(name: string, body: () => any) {
    this.context.subscriptions.push(
        vscode.commands.registerCommand(name, body));
  }

  async shouldReuse(release: string): Promise<boolean> {
    const message =
        `${this.options.executableName} ${release} is already installed!`;
    const use = 'Use the installed version';
    const reinstall = 'Delete it and reinstall';
    const response =
        await vscode.window.showInformationMessage(message, use, reinstall);
    if (response == use) {
      // Find the executable within the existing directory.
      return true;
    } else if (response == reinstall) {
      // Remove the existing installation.
      return false;
    } else {
      // User dismissed prompt, bail out.
      return undefined;
    }
  }

  async promptReload(message: string) {
    if (await vscode.window.showInformationMessage(message, 'Reload window'))
      vscode.commands.executeCommand('workbench.action.reloadWindow');
  }

  async showHelp(message: string, url: string) {
    if (await vscode.window.showInformationMessage(message, 'Open website'))
      vscode.env.openExternal(vscode.Uri.parse(url));
  }

  async promptUpdate(oldVersion: string, newVersion: string) {
    const {executableName} = this.options;
    const message =
        `An updated ${executableName} is available.\n ` +
        `Would you like to upgrade to ${executableName} ${newVersion}? ` +
        `(from ${oldVersion})`;
    const update = `Install ${executableName} ${newVersion}`;
    const dontCheck = 'Don\'t ask again';
    const response =
        await vscode.window.showInformationMessage(message, update, dontCheck)
    if (response == update) {
      common.installLatest(this);
    }
    else if (response == dontCheck) {
      this.config.update('checkUpdates', false,
                         vscode.ConfigurationTarget.Global);
    }
  }

  async promptInstall(version: string) {
    const p = this.executablePath;
    const {executableName} = this.options;
    let message = '';
    if (p.indexOf(path.sep) < 0) {
      message += `The '${p}' was not found on your PATH.\n`;
    } else {
      message += `The ${executableName} binary '${p}' was not found.\n`;
    }
    message +=
        `Would you like to download and install ${executableName} ${version}?`;
    if (await vscode.window.showInformationMessage(message, 'Install'))
      common.installLatest(this);
  }

  get executablePath(): string { return this.config.get<string>('path')!; }
  set executablePath(p: string) {
    this.config.update('path', p, vscode.ConfigurationTarget.Global);
  }
}
