import { Box, Text } from 'ink'
import { VERSION } from '@zuse/core'

export function App() {
  return (
    <Box flexDirection="column" padding={1}>
      <Text color="cyan">Hello from Zuse</Text>
      <Text dimColor>core version: {VERSION}</Text>
    </Box>
  )
}