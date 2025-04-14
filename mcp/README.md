# simple-mcp-server MCP server

A basic MCP server using Python MCP SDK

## Components

### Resources

The server implements a simple note storage system with:
- Custom note:// URI scheme for accessing individual notes
- Each note resource has a name, description and text/plain mimetype

### Prompts

The server provides a single prompt:
- summarize-notes: Creates summaries of all stored notes
  - Optional "style" argument to control detail level (brief/detailed)
  - Generates prompt combining all current notes with style preference

### Tools

The server implements one tool:
- add-note: Adds a new note to the server
  - Takes "name" and "content" as required string arguments
  - Updates server state and notifies clients of resource changes

## Configuration

### GitHub Copilot Integration

This project includes GitHub Copilot instructions to help with code generation and provide context about the MCP server:

1. Make sure you have the GitHub Copilot extension installed in VS Code.
2. The project includes a `.github/copilot-instructions.md` file that provides specialized instructions for Copilot.
3. When working with this codebase, Copilot will use these instructions to generate more relevant and context-aware code suggestions.

### UV Version Management

This project uses UV for Python package management. UV is a fast, reliable package installer and resolver for Python.

Key UV commands for this project:

```bash
# Create/update virtual environment with required dependencies
uv venv

# Activate the virtual environment
source .venv/bin/activate  # On Unix/macOS
# or
.venv\Scripts\activate     # On Windows

# Install dependencies from pyproject.toml
uv sync --dev --all-extras

# Add new dependencies
uv add package-name

# Update dependencies
uv pip freeze > requirements.txt  # Export current state
uv pip install -r requirements.txt --upgrade  # Update all packages
```

## Quickstart

### Install

#### Claude Desktop

On MacOS: `~/Library/Application\ Support/Claude/claude_desktop_config.json`
On Windows: `%APPDATA%/Claude/claude_desktop_config.json`

<details>
  <summary>Development/Unpublished Servers Configuration</summary>
  ```
  "mcpServers": {
    "simple-mcp-server": {
      "command": "uv",
      "args": [
        "--directory",
        "/Users/chrislloydjones/git/str-mcp-purview/mcp",
        "run",
        "simple-mcp-server"
      ]
    }
  }
  ```
</details>

<details>
  <summary>Published Servers Configuration</summary>
  ```
  "mcpServers": {
    "simple-mcp-server": {
      "command": "uvx",
      "args": [
        "simple-mcp-server"
      ]
    }
  }
  ```
</details>

## Development

### Building and Publishing

To prepare the package for distribution:

1. Sync dependencies and update lockfile:
```bash
uv sync
```

2. Build package distributions:
```bash
uv build
```

This will create source and wheel distributions in the `dist/` directory.

3. Publish to PyPI:
```bash
uv publish
```

Note: You'll need to set PyPI credentials via environment variables or command flags:
- Token: `--token` or `UV_PUBLISH_TOKEN`
- Or username/password: `--username`/`UV_PUBLISH_USERNAME` and `--password`/`UV_PUBLISH_PASSWORD`

### Debugging

Since MCP servers run over stdio, debugging can be challenging. For the best debugging
experience, we strongly recommend using the [MCP Inspector](https://github.com/modelcontextprotocol/inspector).


You can launch the MCP Inspector via [`npm`](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm) with this command:

```bash
npx @modelcontextprotocol/inspector uv --directory /Users/chrislloydjones/git/str-mcp-purview/mcp run simple-mcp-server
```


Upon launching, the Inspector will display a URL that you can access in your browser to begin debugging.ls