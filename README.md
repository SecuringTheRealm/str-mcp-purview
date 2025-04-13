# str-mcp-purview
> MCP Server for Microsoft Purview Integration - with an optional D&D flavour.

![GitHub issues](https://img.shields.io/github/issues/SecuringTheRealm/str-mcp-purview)
![GitHub](https://img.shields.io/github/license/SecuringTheRealm/str-mcp-purview)
![GitHub Repo stars](https://img.shields.io/github/stars/SecuringTheRealm/str-mcp-purview?style=social)
[![Python](https://img.shields.io/badge/--3178C6?logo=python&logoColor=ffffff)](https://www.python.org/)
[![Azure](https://img.shields.io/badge/--3178C6?logo=microsoftazure&logoColor=ffffff)](https://learn.microsoft.com/en-us/azure/developer/azure-developer-cli/?WT.mc_id=AI-MVP-5004204)
[![UV](https://img.shields.io/badge/--3178C6?logo=python&logoColor=ffffff)](https://docs.astral.sh/uv/)

This project implements a Model Context Protocol (MCP) server that integrates with Microsoft Purview, allowing LLMs to interact with Purview data through a secure interface. The server provides tools to monitor sensitivity label changes, analyze audit logs, manage data sources, and gain insights from your Microsoft Purview implementation.

## Features

- 🔍 **Audit Log Analysis**: Access and analyze Purview audit logs to monitor data governance activities
- 🏷️ **Sensitivity Label Tracking**: Monitor changes to sensitivity labels in emails and documents
- 🔄 **Data Source Scanning**: Trigger scans of your data sources programmatically
- 📊 **Data Catalog Insights**: Get summary statistics about your entire data estate
- 🔗 **Data Lineage Exploration**: Visualize and analyze how data flows through your organization

## Prerequisites

- Python 3.8 or higher
- An Azure subscription with Purview configured
- Appropriate permissions to access Purview resources
- [UV package manager](https://docs.astral.sh/uv/installation/) installed

## Installation

1. Clone this repository:
   ```bash
   git clone <your-repo-url>
   cd str-mcp-purview
   ```

2. Configure your environment variables:
   ```bash
   cd src
   cp .env.template .env
   ```

   Then edit the `.env` file with your Purview account details and authentication information.

3. Run the server, and install dependencies: at the same time
   ```bash
   uv run server.py
   ```

## Configuration

The server uses environment variables for configuration. Copy the `.env.template` file to `.env` and fill in:

```
# Azure Purview Configuration
PURVIEW_ACCOUNT_NAME=your-purview-account-name
PURVIEW_ENDPOINT=https://your-purview-account-name.purview.azure.com

# Azure Subscription Information
AZURE_SUBSCRIPTION_ID=your-subscription-id
AZURE_RESOURCE_GROUP=your-resource-group-name

# Authentication (DefaultAzureCredential will be used if these are not provided)
# For service principal authentication
AZURE_TENANT_ID=your-tenant-id
AZURE_CLIENT_ID=your-client-id
AZURE_CLIENT_SECRET=your-client-secret
```

## Authentication

This server supports multiple authentication methods following Azure best practices:

1. **Managed Identity**: When deployed to Azure, uses system-assigned or user-assigned managed identities (recommended)
2. **DefaultAzureCredential**: Tries multiple authentication methods in sequence, including environment variables, managed identity, and interactive login
3. **Service Principal**: Falls back to client secret authentication if client ID, client secret, and tenant ID are provided

## Starting the MCP Server

Start the server using one of these methods:

### Basic Start

```bash
cd str-mcp-purview
python src/server.py
```

### Using MCP CLI

```bash
# Standard mode
mcp run src/server.py

# Development mode with inspector
mcp dev src/server.py
```

### Integration with Claude Desktop or Other MCP Clients

To install the server as an MCP extension:

```bash
mcp install src/server.py --name "Purview Insights"
```

## Available Tools

The MCP server exposes these tools for LLMs:

### `get_audit_logs`

Retrieve audit logs from Purview for a specified time period.

**Parameters:**
- `start_time`: Start time in ISO format (YYYY-MM-DDTHH:MM:SS)
- `end_time`: (Optional) End time in ISO format, defaults to current time
- `limit`: Maximum number of logs to return (default: 100)

**Example usage:**
```python
logs = await get_audit_logs(start_time="2025-04-10T00:00:00", limit=50)
```

### `get_sensitivity_label_changes`

Get a report of sensitivity label changes in a specified time period.

**Parameters:**
- `start_time`: Start time in ISO format (YYYY-MM-DDTHH:MM:SS)
- `end_time`: (Optional) End time in ISO format, defaults to current time

**Example usage:**
```python
report = await get_sensitivity_label_changes(start_time="2025-04-01T00:00:00")
```

### `scan_data_source`

Initiate a scan on a Purview data source.

**Parameters:**
- `data_source_name`: Name of the data source to scan
- `scan_level`: Type of scan (Incremental or Full)

**Example usage:**
```python
result = await scan_data_source(data_source_name="MyDataLake", scan_level="Full")
```

### `get_data_catalog_summary`

Get a summary of the data catalog including asset counts by type.

**Example usage:**
```python
summary = await get_data_catalog_summary()
```

### `get_data_lineage`

Get data lineage information for a specific entity.

**Parameters:**
- `entity_id`: ID of the entity to retrieve lineage for
- `depth`: Depth of lineage graph to retrieve (default: 3)

**Example usage:**
```python
lineage = await get_data_lineage(entity_id="guid-123-456", depth=5)
```

## Available Resources

The server provides these information resources:

### `purview-overview`

Provides an overview of your Purview account configuration and status.

### `email-sensitivity-guide`

Provides guidance on email sensitivity labels and their management.

## Security Considerations

This server follows Azure best practices for security:

1. **Secure Authentication**: Uses DefaultAzureCredential for proper authentication chains
2. **No Hardcoded Credentials**: All sensitive information is stored in environment variables
3. **Error Handling**: Comprehensive error handling prevents information leakage
4. **Least Privilege**: Use RBAC in Azure to provide minimal required permissions to the service principal

## Extending the Server

To add new tools:

1. Create a new function with the `@mcp.tool()` decorator
2. Define parameters and return types
3. Implement the tool functionality using the Purview client

To add new resources:

1. Create a new function with the `@mcp.resource(path="your-path")` decorator
2. Return the content as a string (Markdown format recommended)

## Troubleshooting

If you encounter issues:

1. **Authentication Errors**: Verify your environment variables and check if the service principal has sufficient permissions
2. **Connection Issues**: Ensure your Purview endpoint is correctly specified
3. **Tool Errors**: Check the error logs for specific error messages

## Solutions Referenced
- [Microsoft Purview documentation](https://learn.microsoft.com/en-us/purview/purview?WT.mc_id=AI-MVP-5004204)
- [Microsoft Purview Python SDK tutorial](https://learn.microsoft.com/en-us/purview/tutorial-using-python-sdk?WT.mc_id=AI-MVP-5004204)
- [Azure Identity authentication library](https://learn.microsoft.com/en-us/python/api/overview/azure/identity-readme?WT.mc_id=AI-MVP-5004204)
- [Microsoft Purview sensitivity labels](https://learn.microsoft.com/en-us/purview/create-sensitivity-label?WT.mc_id=AI-MVP-5004204)
- [Model Context Protocol (MCP) Python SDK](https://github.com/modelcontextprotocol/python-sdk)

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the LICENSE file for details.