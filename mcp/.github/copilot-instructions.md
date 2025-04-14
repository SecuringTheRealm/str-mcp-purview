<!-- Use this file to provide workspace-specific custom instructions to Copilot. For more details, visit https://code.visualstudio.com/docs/copilot/copilot-customization#_use-a-githubcopilotinstructionsmd-file -->

# GitHub Copilot Instructions for Model Context Protocol Server

This is a Model Context Protocol (MCP) server project built with the Python MCP SDK.

## About MCP

The Model Context Protocol (MCP) standardizes interactions between LLMs and context providers. This enables:
- Chat applications to use any LLM
- LLMs to access context from any provider
- Context providers to work with any LLM

## Project Structure and Best Practices

- Use `mcp` library and its abstractions for implementing MCP endpoints
- Follow PEP 8 style guidelines for Python code
- Use type hints to improve code readability and IDE support
- Include proper error handling for API calls
- Write docstrings for all functions and classes

## SDK Resources

- GitHub repository: https://github.com/modelcontextprotocol/create-python-server
- MCP website: https://modelcontextprotocol.io
- MCP documentation: https://modelcontextprotocol.io/llms-full.txt

When generating code, prioritize robustness, typed interfaces, and clear error handling.