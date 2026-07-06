import { useCallback, useEffect, useRef, forwardRef, useImperativeHandle } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { json } from '@codemirror/lang-json'
import { oneDark } from '@codemirror/theme-one-dark'
import { EditorView, drawSelection, highlightSpecialChars } from '@codemirror/view'
import { EditorState } from '@codemirror/state'

interface Props {
  value: string
  onChange?: (value: string) => void
  readOnly?: boolean
  height?: string
  minHeight?: string
  wordWrap?: boolean
  className?: string
  onValidationError?: (errors: string[]) => void
}

export interface CodeMirrorEditorRef {
  view: EditorView | null
}

const CodeMirrorEditor = forwardRef<CodeMirrorEditorRef, Props>(({
  value,
  onChange,
  readOnly = false,
  height = '500px',
  minHeight = '200px',
  wordWrap = false,
  className,
  onValidationError,
}, ref) => {
  const editorViewRef = useRef<EditorView | null>(null)

  useImperativeHandle(ref, () => ({
    get view() {
      return editorViewRef.current
    }
  }))

  // Validate JSON and report errors
  const validateJson = useCallback((jsonString: string) => {
    // Skip validation if empty or whitespace only
    if (!jsonString || !jsonString.trim()) {
      onValidationError?.([])
      return
    }

    const errors: string[] = []
    try {
      JSON.parse(jsonString)
    } catch (e: any) {
      const match = e.message.match(/position (\d+)/)
      if (match) {
        const position = parseInt(match[1], 10)
        const lines = jsonString.substring(0, position).split('\n')
        const lineNumber = lines.length
        const column = lines[lines.length - 1].length + 1
        errors.push(`第 ${lineNumber} 行: JSON 格式错误 (${e.message})`)
      } else {
        errors.push(`JSON 格式错误: ${e.message}`)
      }
    }
    onValidationError?.(errors)
  }, [onValidationError])

  // Validate on value change
  useEffect(() => {
    validateJson(value)
  }, [value, validateJson])

  // Create extensions for CodeMirror
  const extensions = [
    json(),
    drawSelection(), // Better selection handling for mobile
    highlightSpecialChars(),
    EditorView.theme({
      '&': {
        height: height,
        minHeight: minHeight,
        fontSize: '13px',
      },
      '.cm-content': {
        fontFamily: 'Monaco, Menlo, "Ubuntu Mono", monospace',
        lineHeight: '20px',
        caretColor: '#fff',
      },
      '.cm-gutters': {
        backgroundColor: '#1e1e1e',
        borderRight: '1px solid #333',
      },
      '.cm-activeLine': {
        backgroundColor: '#2a2a2a',
      },
      '.cm-selectionBackground, .cm-selectionBackground:focus': {
        backgroundColor: '#264f78 !important',
      },
      '.cm-cursor, .cm-dropCursor': {
        borderLeftColor: '#fff',
      },
      '&.cm-focused .cm-selectionBackground': {
        backgroundColor: '#264f78 !important',
      },
      // Mobile-specific styles
      '@media (max-width: 768px)': {
        '&': {
          touchAction: 'manipulation',
        },
        '.cm-content': {
          touchAction: 'manipulation',
          WebkitUserSelect: 'text',
          userSelect: 'text',
        },
      },
    }),
  ]

  // Add word wrap extension if enabled
  if (wordWrap) {
    extensions.push(EditorView.lineWrapping)
  }

  // Enable mobile-friendly selection
  extensions.push(
    EditorState.allowMultipleSelections.of(true),
  )

  const handleChange = useCallback((val: string) => {
    onChange?.(val)
  }, [onChange])

  return (
    <div className={className} style={{ position: 'relative' }}>
      <CodeMirror
        value={value}
        height={height}
        minHeight={minHeight}
        theme={oneDark}
        extensions={extensions}
        onChange={handleChange}
        readOnly={readOnly}
        basicSetup={{
          lineNumbers: true,
          highlightActiveLineGutter: true,
          highlightActiveLine: true,
          foldGutter: true,
          autocompletion: true,
          bracketMatching: true,
          closeBrackets: true,
          indentOnInput: true,
          tabSize: 2,
        }}
        onCreateEditor={(view: EditorView) => {
          editorViewRef.current = view
        }}
      />
    </div>
  )
})

CodeMirrorEditor.displayName = 'CodeMirrorEditor'

export default CodeMirrorEditor
