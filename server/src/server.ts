import {
	createConnection,
	TextDocuments,
	DiagnosticSeverity,
	ProposedFeatures,
	InitializeParams,
	TextDocumentSyncKind,
	InitializeResult,
	Diagnostic
} from 'vscode-languageserver/node';
import {
	TextDocument
} from 'vscode-languageserver-textdocument';
import {Spectral, Document, Ruleset} from '@stoplight/spectral-core';
import {Yaml} from '@stoplight/spectral-parsers';
import {oas, asyncapi} from '@stoplight/spectral-rulesets';

const spectral = new Spectral();
spectral.setRuleset({...asyncapi, ...oas} as unknown as Ruleset);

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

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(change => {
	validateTextDocument(change.document);
});

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
	const text = textDocument.getText();
	const issues = await spectral.run(new Document(text, Yaml, 'spec.yaml'));
	const diagnostics = issues.map(issue => ({
			severity: issue.severity + 1,
			code: issue.code,
			range: issue.range,
			message: issue.message,
			source: 'OpenAPI Linter'
	}));
	// Send the computed diagnostics to VSCode.
	connection.sendDiagnostics({ uri: textDocument.uri, diagnostics: (diagnostics as Diagnostic[]) });
}

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// Listen on the connection
connection.listen();
