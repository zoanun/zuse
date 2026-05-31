import { Box, Text } from 'ink'
import TextInput from 'ink-text-input'
import { useState } from 'react'

interface InputBoxProps {
  onSubmit: (text: string) => void
  isDisabled: boolean
}

export function InputBox({ onSubmit, isDisabled }: InputBoxProps) {
  const [value, setValue] = useState('')

  const handleSubmit = () => {
    if (value.trim() && !isDisabled) {
      onSubmit(value.trim())
      setValue('')
    }
  }

  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1}>
      <Text color="cyan">❯ </Text>
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={handleSubmit}
        placeholder={isDisabled ? 'Waiting for response...' : 'Type your message...'}
        showCursor={!isDisabled}
      />
    </Box>
  )
}