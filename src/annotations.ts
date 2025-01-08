/*
Portions of this software are derived from [ghcid](https://github.com/ndmitchell/ghcid) and subject to the original authors licensing terms, reproduced below.

> Copyright Neil Mitchell 2014-2023.
> All rights reserved.
>
> Redistribution and use in source and binary forms, with or without
> modification, are permitted provided that the following conditions are
> met:
>
>     * Redistributions of source code must retain the above copyright
>       notice, this list of conditions and the following disclaimer.
>
>     * Redistributions in binary form must reproduce the above
>       copyright notice, this list of conditions and the following
>       disclaimer in the documentation and/or other materials provided
>       with the distribution.
>
>     * Neither the name of Neil Mitchell nor the names of other
>       contributors may be used to endorse or promote products derived
>       from this software without specific prior written permission.
>
> THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
> "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
> LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
> A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
> OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
> SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
> LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
> DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
> THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
> (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
> OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

import { dirname, isAbsolute } from 'path'
import * as vscode from 'vscode'

import { Annotation, AnnotationsConfig, LanguageConfig, alloglot } from './config'
import { IHierarchicalOutputChannel } from './utils'

export function makeAnnotations(output: IHierarchicalOutputChannel, config: LanguageConfig, verboseOutput: boolean): vscode.Disposable {
  output.appendLine(alloglot.ui.startingAnnotations)
  const { languageId, annotations } = config
  if (!languageId || !annotations || annotations.length === 0) return vscode.Disposable.from()

  const watchers: Array<vscode.Disposable> = annotations.map(cfg => watchAnnotationsFile(languageId, cfg, verboseOutput ? output.local(cfg.file).split() : undefined))

  const quickFixes = vscode.languages.registerCodeActionsProvider(
    languageId,
    { provideCodeActions: (document, range, context) => context.diagnostics.map(asQuickFixes).flat() },
    { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
  )

  output.appendLine(alloglot.ui.annotationsStarted)
  return vscode.Disposable.from(
    quickFixes,
    ...watchers
  )
}

function watchAnnotationsFile(languageId: string, cfg: AnnotationsConfig, output?: vscode.OutputChannel): vscode.Disposable {
  const stripAnsi: (raw: string) => string = require('strip-ansi').default
  const includeEndChar = cfg.mapping.includeEndColumn
    ? (n: number | undefined) => n && n + 1
    : (n: number | undefined) => n

  const diagnostics = vscode.languages.createDiagnosticCollection(`${alloglot.collections.annotations}-${languageId}-${cfg.file}`)
  output?.appendLine(`Created diagnostic collection: ${diagnostics.name}`)

  const messagePath = path<string>(cfg.mapping.message)
  const filePath = path<string>(cfg.mapping.file)
  const startLinePath = path<number>(cfg.mapping.startLine)
  const startColumnPath = path<number>(cfg.mapping.startColumn)
  const endLinePath = path<number>(cfg.mapping.endLine)
  const endColumnPath = path<number>(cfg.mapping.endColumn)
  const sourcePath = path<string>(cfg.mapping.source)
  const severityPath = path<string>(cfg.mapping.severity)
  const replacementsPath = path<string | Array<string>>(cfg.mapping.replacements)
  const referenceCodePath = path<string | number>(cfg.mapping.referenceCode)

  function marshalAnnotation(json: any): Annotation | undefined {
    output?.appendLine(`marshalAnnotation <- ${JSON.stringify(json)}`)
    const ansiMessage = messagePath(json)
    const message = ansiMessage ? stripAnsi(ansiMessage) : undefined
    const file = filePath(json)
    if (!message || !file) return

    const startLine = startLinePath(json) || 1
    const startColumn = startColumnPath(json) || 1
    const endLine = endLinePath(json) || startLine
    const endColumn = includeEndChar(endColumnPath(json)) || (startColumn + 1)

    const replacements: Array<string> =
      typeof replacementsPath(json) === 'string'
        ? [replacementsPath(json) as string]
        : replacementsPath(json) as Array<string>

    const source = sourcePath(json) || `${cfg.file}`
    const severity = parseSeverity(severityPath(json))
    const referenceCode = referenceCodePath(json)?.toString()

    const result = {message, file, startLine, startColumn, endLine, endColumn, replacements, source, severity, referenceCode}
    output?.appendLine(`marshalAnnotation -> ${JSON.stringify(result)}`)

    return result
  }

  function readAnnotations(bytes: Uint8Array): Array<Annotation> {
    const contents = Buffer.from(bytes).toString('utf-8')
    const jsons: Array<any> = cfg.format === 'jsonl'
      ? contents.split('\n').map(line => JSON.parse(line))
      : Array.isArray(cfg.format)
        ? path(cfg.format)(JSON.parse(contents))
        : JSON.parse(contents)

    output?.appendLine(`readAnnotations <- ${JSON.stringify(jsons)}`)
    const annotations = jsons.map(marshalAnnotation).filter(x => x) as Array<Annotation>
    output?.appendLine(`readAnnotations -> ${JSON.stringify(annotations)}`)
    return annotations
  }

  function annotationsBySourceFile(annotations: Array<Annotation>): Map<string, Array<Annotation>> {
    output?.appendLine(`annotationsBySourceFile <- ${JSON.stringify(annotations)}`)
    const sorted = new Map<string, Array<Annotation>>()
    annotations.forEach(annotation => {
      const annotationsForFile = sorted.get(annotation.file)
      annotationsForFile
        ? annotationsForFile.push(annotation)
        : sorted.set(annotation.file, [annotation])
    })
    output?.appendLine(`annotationsBySourceFile -> ${JSON.stringify(sorted)}`)
    return sorted
  }

  function addAnnotations(annFile: vscode.Uri): void {
    output?.appendLine('entering addAnnotations')
    diagnostics.clear()
    const basedir = vscode.Uri.file(dirname(annFile.fsPath))
    output?.appendLine(`basedir: ${basedir}`)
    vscode.workspace.fs.readFile(annFile).then(bytes => {
      annotationsBySourceFile(readAnnotations(bytes)).forEach((anns, srcFile) => {
        const srcUri = fileUri(basedir, srcFile)
        output?.appendLine(`srcUri: ${srcUri}`)
        const diags = anns.map(ann => annotationAsDiagnostic(basedir, ann, output))
        output?.appendLine(`diags: ${JSON.stringify(diags)}`)
        diagnostics.set(srcUri, diags)
        output?.appendLine('leaving addAnnotations')
      })
    })
  }

  const watchers = vscode.workspace.workspaceFolders?.map(ws => {
    const pattern = new vscode.RelativePattern(ws, cfg.file)
    const watcher = vscode.workspace.createFileSystemWatcher(pattern, false, false, false)

    watcher.onDidChange(addAnnotations)
    watcher.onDidCreate(addAnnotations)
    watcher.onDidDelete(() => diagnostics.clear())

    return watcher
  }) || []

  const cleanup = vscode.workspace.onDidSaveTextDocument(doc => {
    if (doc.languageId === languageId) {
      diagnostics.delete(doc.uri)
    }
  })

  return vscode.Disposable.from(cleanup, ...watchers)
}

function annotationAsDiagnostic(basedir: vscode.Uri, ann: Annotation, output?: vscode.OutputChannel): vscode.Diagnostic {
  output?.appendLine(`annotationAsDiagnostic <- ${basedir}, ${JSON.stringify(ann)}`)
  const range = new vscode.Range(
    new vscode.Position(ann.startLine - 1, ann.startColumn - 1),
    new vscode.Position(ann.endLine - 1, ann.endColumn - 1)
  )

  // we are abusing the relatedInformation field to store replacements
  // we look them up later when we need to create quick fixes
  const relatedInformation = ann.replacements?.map(replacement => {
    const srcUri = fileUri(basedir, ann.file)
    const srcLocation = new vscode.Location(srcUri, range)
    const relInfo = new vscode.DiagnosticRelatedInformation(srcLocation, replacement)
    return relInfo
  })

  // i wish they gave an all-args constructor
  const diagnostic = new vscode.Diagnostic(range, ann.message, asDiagnosticSeverity(ann.severity))
  diagnostic.source = ann.source
  diagnostic.relatedInformation = relatedInformation
  diagnostic.code = ann.referenceCode

  output?.appendLine(`annotationAsDiagnostic -> ${JSON.stringify(diagnostic)}`)
  return diagnostic
}

function asDiagnosticSeverity(sev: Annotation['severity']): vscode.DiagnosticSeverity {
  switch (sev) {
    case 'error': return vscode.DiagnosticSeverity.Error
    case 'warning': return vscode.DiagnosticSeverity.Warning
    case 'info': return vscode.DiagnosticSeverity.Information
    case 'hint': return vscode.DiagnosticSeverity.Hint
  }
}

// this depends on the fact that we're abusing the `relatedInformation` field
// see `annotationAsDiagnostic` above
function asQuickFixes(diag: vscode.Diagnostic): Array<vscode.CodeAction> {
  const actions = diag.relatedInformation?.map(info => {
    const action = new vscode.CodeAction(diag.message, vscode.CodeActionKind.QuickFix)
    action.diagnostics = [diag]
    action.edit = new vscode.WorkspaceEdit
    action.edit.replace(info.location.uri, info.location.range, info.message)
    return action
  })
  return actions || []
}

function path<T>(keys: Array<string> | undefined): (json: any) => T | undefined {
  if (!keys) return () => undefined
  else return json => {
    const result = keys.reduce((acc, key) => acc?.[key], json)
    if (result) return result as T
    else return undefined
  }
}

function parseSeverity(raw: string | undefined): Annotation['severity'] {
  if (!raw) return 'error'
  const lower = raw.toLowerCase()
  if (lower.includes('error')) return 'error'
  if (lower.includes('warning')) return 'warning'
  if (lower.includes('info')) return 'info'
  if (lower.includes('hint')) return 'hint'
  return 'error'
}

function fileUri(basedir: vscode.Uri, file: string): vscode.Uri {
  return isAbsolute(file)
    ? vscode.Uri.file(file)
    : vscode.Uri.joinPath(basedir, file)
}
