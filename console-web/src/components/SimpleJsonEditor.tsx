import { useState, useEffect, forwardRef } from 'react'
import { Card } from 'antd'

interface Props {
  value: string
  onChange?: (value: string) => void
  height?: string
  onValidationError?: (errors: string[]) => void
  readOnly?: boolean
}

const SimpleJsonEditor = forwardRef<HTMLTextAreaElement, Props>(
  ({ value, onChange, height = '400px', onValidationError, readOnly = false }, ref) => {
    const [isValid, setIsValid] = useState(true)

    useEffect(() => {
      validateJson(value)
    }, [value])

    const validateJson = (jsonString: string) => {
      if (!jsonString || !jsonString.trim()) {
        setIsValid(true)
        onValidationError?.([])
        return
      }

      try {
        JSON.parse(jsonString)
        setIsValid(true)
        onValidationError?.([])
      } catch (e: any) {
        setIsValid(false)
        onValidationError?.([`JSON 格式错误: ${e.message}`])
      }
    }

    const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = e.target.value
      onChange?.(newValue)
    }

    return (
      <Card styles={{ body: { padding: 0 } }}>
        <textarea
          ref={ref}
          value={value}
          onChange={handleChange}
          readOnly={readOnly}
          style={{
            width: '100%',
            height: height,
            backgroundColor: '#1e1e1e',
            color: '#d4d4d4',
            border: 'none',
            padding: '12px',
            fontFamily: 'Monaco, Menlo, "Ubuntu Mono", monospace',
            fontSize: '13px',
            lineHeight: '20px',
            resize: 'vertical',
            outline: 'none',
            borderLeft: isValid ? '3px solid #52c41a' : '3px solid #ff4d4f',
          }}
          spellCheck={false}
        />
      </Card>
    )
  }
)

SimpleJsonEditor.displayName = 'SimpleJsonEditor'

export default SimpleJsonEditor
