type AgentResponseSummary = {
  text: string
  isError: boolean
  toolName?: string
  toolStatus?: string
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

export function summarizeAgentResponse(rawResponse: unknown): AgentResponseSummary | null {
  if (typeof rawResponse !== 'string') return null

  const decoded = decodeHtmlEntities(rawResponse).trim()
  if (!decoded) return null

  const toolResults = [...decoded.matchAll(/<tool_result_[^>]*name="([^"]+)"[^>]*status="([^"]+)"/gi)]
  const lastToolResult = toolResults.length > 0 ? toolResults[toolResults.length - 1] : null
  const toolName = lastToolResult?.[1]
  const toolStatus = lastToolResult?.[2]

  const cleaned = decoded
    .replace(/<tool_[^>]+>[\s\S]*?<\/tool_[^>]+>/gi, ' ')
    .replace(/<tool_result_[^>]+>[\s\S]*?<\/tool_result_[^>]+>/gi, ' ')
    .replace(/<param[^>]*>[\s\S]*?<\/param>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (cleaned) {
    return { text: cleaned, isError: false, toolName, toolStatus }
  }

  if (toolName && toolStatus) {
    return {
      text: toolStatus === 'error'
        ? `Tool ${toolName} returned error`
        : `Tool ${toolName} finished with status ${toolStatus}`,
      isError: toolStatus === 'error',
      toolName,
      toolStatus,
    }
  }

  const toolCallMatch = decoded.match(/<tool_[^>]*name="([^"]+)"/i)
  if (toolCallMatch?.[1]) {
    return {
      text: `Agent invoked ${toolCallMatch[1]}`,
      isError: false,
    }
  }

  return {
    text: decoded,
    isError: false,
  }
}
