import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  TextDocumentSyncKind,
  InitializeResult,
  Diagnostic,
  DidChangeConfigurationNotification
} from 'vscode-languageserver/node';
import {
  TextDocument
} from 'vscode-languageserver-textdocument';
import { Spectral, Document } from '@stoplight/spectral-core';
import { Yaml, Json } from '@stoplight/spectral-parsers';
import * as fs from 'fs';
import { join } from 'path';
import { bundleAndLoadRuleset } from "@stoplight/spectral-ruleset-bundler/dist/loader/node";
import * as minimatch from 'minimatch';
import { resolveFile } from '@stoplight/json-ref-readers';
import { Resolver, Cache } from '@stoplight/json-ref-resolver';

interface LinterSettings {
  spectralRulesetsFile: string;
  validateFiles: string[];
}
let settings: LinterSettings = {
  spectralRulesetsFile: '/.spectral-default.yaml',
  validateFiles: []
};
const fakeFS: any = {
  promises: {
    async readFile(filepath: string) {
      if (filepath === '/.spectral-default.yaml') {
        return `extends: ["spectral:oas", "spectral:asyncapi"]`;
      }
      return fs.promises.readFile(filepath);
    },
  },
};
const cache = new Cache();
const spectral = new Spectral({
  resolver: new Resolver({
    resolvers: {
      file: { resolve: resolveFile },
    },
    uriCache: cache
  })
});
let initialized = false;
let watcher: fs.FSWatcher | null = null;
const loadConfig = async () => {
  if (initialized) {
    // load config
    settings = await connection.workspace.getConfiguration('openApiLinter') as LinterSettings;
    const globalConfigFile = settings.spectralRulesetsFile;

    // local config
    const workspacePath = (await connection.workspace.getWorkspaceFolders())![0].uri;
    let localRulesetsFile = join(workspacePath, '.spectral.yml');
    if (localRulesetsFile.startsWith('file:')) {
      localRulesetsFile = localRulesetsFile.substring(5);
    }
    if (fs.existsSync(localRulesetsFile)) {
      settings.spectralRulesetsFile = localRulesetsFile;
    }

    // default config
    if (settings.spectralRulesetsFile == null || !fs.existsSync(settings.spectralRulesetsFile)) {
      settings.spectralRulesetsFile = '/.spectral-default.yaml';
    }

    if (settings.spectralRulesetsFile == globalConfigFile) {
      if (watcher !== null) {
        watcher.close();
      }
      watcher = fs.watch(globalConfigFile, async () => {
        await loadConfig();
        documents.all().forEach(validateTextDocument);
      });
    } else if (watcher != null) {
      watcher.close();
      watcher = null;
    }
  }
  const customRules = await bundleAndLoadRuleset(settings.spectralRulesetsFile, {
    fs: fakeFS,
    fetch: globalThis.fetch,
  });
  spectral.setRuleset(customRules);
};
loadConfig();

// Create a connection for the server, using Node's IPC as a transport.
// Also include all preview / proposed LSP features.
const connection = createConnection(ProposedFeatures.all);

// Create a simple text document manager.
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

connection.onInitialize((params: InitializeParams) => {
  const result: InitializeResult = {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
    }
  };
  return result;
});

connection.onInitialized(async () => {
  initialized = true;
  await loadConfig();
  documents.all().forEach(validateTextDocument);
  connection.client.register(DidChangeConfigurationNotification.type, undefined);
});

connection.onDidChangeConfiguration(async change => {
  await loadConfig();
  documents.all().forEach(validateTextDocument);
});

connection.onDidChangeWatchedFiles(async params => {
  await loadConfig();
  documents.all().forEach(validateTextDocument);
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(async change => {
  await validateTextDocument(change.document);
});

documents.onDidSave(change => {
  documents.all().forEach(async document => {
    if (document.getText().includes(change.document.uri.replace(/^.*[\\/]/, ''))) {
      cache.purge();
      await validateTextDocument(document);
    }
  });
});

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
  const text = textDocument.getText();
  let diagnostics: Diagnostic[] = [];
  if (
    (settings.validateFiles.length == 0 && text.startsWith('openapi:'))
    || settings.validateFiles.some(validateFile => minimatch(textDocument.uri, validateFile))
  ) {
    const workspaceFolder = (await connection.workspace.getWorkspaceFolders())![0].uri;
    const filePath = textDocument.uri.substring(workspaceFolder.length + 1);
    const document = filePath.toLowerCase().endsWith('.json') ? new Document(text, Json, filePath) : new Document(text, Yaml, filePath);
    const issues = await spectral.run(document);
    diagnostics = issues.map(issue => ({
      severity: issue.severity + 1,
      code: issue.code,
      range: issue.range,
      message: issue.message,
      source: 'OpenAPI Linter'
    })) as Diagnostic[];
  }
  // Send the computed diagnostics to VSCode.
  connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

documents.onDidClose(e => {
  connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
});

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
