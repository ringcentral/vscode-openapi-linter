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
import {Spectral, Document} from '@stoplight/spectral-core';
import {Yaml, Json} from '@stoplight/spectral-parsers';
import * as fs from 'fs';
import {join} from 'path';
import { bundleAndLoadRuleset } from "@stoplight/spectral-ruleset-bundler/dist/loader/node";
import * as minimatch from 'minimatch';

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
const spectral = new Spectral();
let initialized = false;
const loadConfig = async () => {
  if(initialized) {
    settings = await connection.workspace.getConfiguration('openApiLinter') as LinterSettings;
    const workspacePath = (await connection.workspace.getWorkspaceFolders())![0].uri;
    const spectralRulesetsFile = join(workspacePath, '.spectral.yml');
    if(spectralRulesetsFile.startsWith('file:')) {
      settings.spectralRulesetsFile = spectralRulesetsFile.substring(5);
    }
    if(settings.spectralRulesetsFile == null || !fs.existsSync(settings.spectralRulesetsFile)) {
      settings.spectralRulesetsFile = '/.spectral-default.yaml';
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
documents.onDidChangeContent(change => {
  validateTextDocument(change.document);
});

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
  const text = textDocument.getText();
  let diagnostics: Diagnostic[] = [];
  if(
    (settings.validateFiles.length == 0 && text.startsWith('openapi:'))
    || settings.validateFiles.some(validateFile => minimatch(textDocument.uri, validateFile))
  ) {
    const document = textDocument.uri.toLowerCase().endsWith('.json') ? new Document(text, Json, 'spec.json') : new Document(text, Yaml, 'spec.yaml');
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
