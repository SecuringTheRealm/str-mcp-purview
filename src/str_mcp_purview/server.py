"""
MCP Server for Microsoft Purview Integration

This server exposes Purview functionality as tools and resources through
the Model Context Protocol (MCP).
"""

import asyncio
import datetime
import json
import os
from dataclasses import dataclass
from typing import Any, Dict, Optional

from azure.core.exceptions import HttpResponseError

# Import Azure components with security best practices
from azure.identity import ClientSecretCredential, DefaultAzureCredential
from azure.purview.administration.account import PurviewAccountClient
from azure.purview.catalog import PurviewCatalogClient
from azure.purview.scanning import PurviewScanningClient
from dotenv import load_dotenv
from pydantic import AnyUrl

import mcp.server.stdio
import mcp.types as types
from mcp.server import NotificationOptions, Server
from mcp.server.models import InitializationOptions

# Load environment variables
load_dotenv()

# Create MCP server
server = Server("str-mcp-purview")

# Store server state
state = {
    "config": None,
    "catalog_client": None,
    "scanning_client": None,
    "account_client": None,
    "mgmt_client": None,
    "security_client": None,
}


# Mock classes for demonstration purposes - replace with actual imports when available
class PurviewManagementClient:
    def __init__(self, credential, subscription_id):
        self.credential = credential
        self.subscription_id = subscription_id


class SecurityCenter:
    def __init__(self, credential, subscription_id):
        self.credential = credential
        self.subscription_id = subscription_id


@dataclass
class PurviewConfig:
    """Configuration for Azure Purview connections."""

    account_name: str
    endpoint: str
    subscription_id: str
    resource_group: str
    tenant_id: Optional[str] = None
    client_id: Optional[str] = None
    client_secret: Optional[str] = None


# Resource handlers


@server.list_resources()
async def handle_list_resources() -> list[types.Resource]:
    """
    List available resources.
    """
    resources = [
        types.Resource(
            uri=AnyUrl("purview://overview"),
            name="Purview Overview",
            description="Overview of Purview configuration and status",
            mimeType="text/markdown",
        ),
        types.Resource(
            uri=AnyUrl("purview://email-sensitivity-guide"),
            name="Email Sensitivity Guide",
            description="Guide on email sensitivity labels and management",
            mimeType="text/markdown",
        ),
    ]
    return resources


@server.read_resource()
async def handle_read_resource(uri: AnyUrl) -> str:
    """
    Read a specific resource by its URI.
    """
    if uri.scheme != "purview":
        raise ValueError(f"Unsupported URI scheme: {uri.scheme}")

    if uri.path == "/overview":
        return await get_purview_overview()
    elif uri.path == "/email-sensitivity-guide":
        return await get_email_sensitivity_guide()
    else:
        raise ValueError(f"Resource not found: {uri.path}")


# Tool handlers


@server.list_tools()
async def handle_list_tools() -> list[types.Tool]:
    """
    List available tools.
    Each tool specifies its arguments using JSON Schema validation.
    """
    return [
        types.Tool(
            name="get_audit_logs",
            description="Retrieve audit logs from Purview for the specified time period",
            inputSchema={
                "type": "object",
                "properties": {
                    "start_time": {
                        "type": "string",
                        "description": "Start time in ISO format (YYYY-MM-DDTHH:MM:SS)",
                    },
                    "end_time": {
                        "type": "string",
                        "description": "End time in ISO format (YYYY-MM-DDTHH:MM:SS)",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of logs to return",
                    },
                },
                "required": ["start_time"],
            },
        ),
        types.Tool(
            name="get_sensitivity_label_changes",
            description="Get a report of sensitivity label changes in the specified time period",
            inputSchema={
                "type": "object",
                "properties": {
                    "start_time": {
                        "type": "string",
                        "description": "Start time in ISO format (YYYY-MM-DDTHH:MM:SS)",
                    },
                    "end_time": {
                        "type": "string",
                        "description": "End time in ISO format (YYYY-MM-DDTHH:MM:SS)",
                    },
                },
                "required": ["start_time"],
            },
        ),
        types.Tool(
            name="scan_data_source",
            description="Initiate a scan on a Purview data source",
            inputSchema={
                "type": "object",
                "properties": {
                    "data_source_name": {
                        "type": "string",
                        "description": "Name of the data source to scan",
                    },
                    "scan_level": {
                        "type": "string",
                        "description": "Type of scan (Incremental or Full)",
                    },
                },
                "required": ["data_source_name"],
            },
        ),
        types.Tool(
            name="get_data_catalog_summary",
            description="Get a summary of the data catalog including asset counts by type",
            inputSchema={
                "type": "object",
                "properties": {},
            },
        ),
        types.Tool(
            name="get_data_lineage",
            description="Get data lineage information for a specific entity",
            inputSchema={
                "type": "object",
                "properties": {
                    "entity_id": {
                        "type": "string",
                        "description": "ID of the entity to retrieve lineage for",
                    },
                    "depth": {
                        "type": "integer",
                        "description": "Depth of lineage graph to retrieve",
                    },
                },
                "required": ["entity_id"],
            },
        ),
    ]


@server.call_tool()
async def handle_call_tool(
    name: str, arguments: dict | None
) -> list[types.TextContent | types.ImageContent | types.EmbeddedResource]:
    """
    Handle tool execution requests.
    Tools can modify server state and notify clients of changes.
    """
    arguments = arguments or {}
    result = None

    if name == "get_audit_logs":
        start_time = arguments.get("start_time")
        end_time = arguments.get("end_time")
        limit = arguments.get("limit", 100)
        result = await process_get_audit_logs(start_time, end_time, limit)
    elif name == "get_sensitivity_label_changes":
        start_time = arguments.get("start_time")
        end_time = arguments.get("end_time")
        result = await process_get_sensitivity_label_changes(start_time, end_time)
    elif name == "scan_data_source":
        data_source_name = arguments.get("data_source_name")
        scan_level = arguments.get("scan_level", "Incremental")
        result = await process_scan_data_source(data_source_name, scan_level)
    elif name == "get_data_catalog_summary":
        result = await process_get_data_catalog_summary()
    elif name == "get_data_lineage":
        entity_id = arguments.get("entity_id")
        depth = arguments.get("depth", 3)
        result = await process_get_data_lineage(entity_id, depth)
    else:
        raise ValueError(f"Unknown tool: {name}")

    return [types.TextContent(type="text", text=json.dumps(result, indent=2))]


# Implementation of the resources


async def get_purview_overview() -> str:
    """
    Provide an overview of the Purview account configuration and status.
    """
    if not state.get("account_client"):
        return "Purview client not initialized correctly."

    try:
        config = state.get("config")

        overview = f"""
        # Microsoft Purview Overview

        ## Account Information
        - **Account Name:** {config.account_name}
        - **Endpoint:** {config.endpoint}
        - **Subscription ID:** {config.subscription_id}
        - **Resource Group:** {config.resource_group}

        ## Data Estate Summary
        {json.dumps(await process_get_data_catalog_summary(), indent=2)}

        ## Recent Activity
        Recent audit logs can be fetched using the `get_audit_logs` tool.

        ## Available Tools
        - `get_audit_logs`: Retrieve audit logs for a specified time period
        - `get_sensitivity_label_changes`: Get a report of sensitivity label changes
        - `scan_data_source`: Trigger a scan on a specific data source
        - `get_data_catalog_summary`: Get summary statistics for the data catalog
        - `get_data_lineage`: Get lineage information for a specific entity
        """

        return overview
    except Exception as e:
        return f"Error generating Purview overview: {str(e)}"


async def get_email_sensitivity_guide() -> str:
    """
    Provide guidance on email sensitivity labels and their management.
    """
    guide = """
    # Email Sensitivity Label Guide

    ## Overview
    Sensitivity labels help protect sensitive content from unauthorized access.
    When applied to emails, these labels can enforce encryption, watermarking,
    and other protection measures.

    ## Common Labels
    1. **Public** - Information freely available outside the organization
    2. **General** - Non-sensitive internal information
    3. **Confidential** - Sensitive information, limited distribution
    4. **Highly Confidential** - Extremely sensitive information, strictly controlled

    ## Monitoring Label Changes
    To monitor changes to sensitivity labels:
    - Use the `get_sensitivity_label_changes` tool to get reports on label changes
    - Investigate unexpected changes to ensure compliance
    - Review audit logs regularly using the `get_audit_logs` tool

    ## Best Practices
    - Regularly audit sensitivity label usage
    - Ensure labels are applied consistently
    - Train users on proper label application
    - Monitor for potential misuse or data leakage
    """

    return guide


# Implementation of the tools


async def process_get_audit_logs(
    start_time: str,
    end_time: Optional[str] = None,
    limit: int = 100,
) -> Dict[str, Any]:
    """
    Retrieve audit logs from Purview for the specified time period.
    """
    if not state.get("catalog_client"):
        return {"error": "Purview client not initialized correctly"}

    try:
        catalog_client = state.get("catalog_client")
        security_client = state.get("security_client")

        # Format the time parameters
        if not end_time:
            end_time = datetime.datetime.utcnow().isoformat() + "Z"

        # In a real implementation, you would use the appropriate Purview API
        # This is a placeholder for demonstration
        # Example query to get audit logs, adjust according to the actual API
        query = {"startTime": start_time, "endTime": end_time, "limit": limit}

        print(f"Fetching audit logs from {start_time} to {end_time}")
        # Placeholder for actual API call
        # logs = catalog_client.audit.get_logs(query)

        # Simulated response for demonstration
        logs = [
            {
                "timestamp": "2025-04-13T10:30:00Z",
                "userPrincipal": "user@example.com",
                "action": "ViewAsset",
                "resourceType": "Table",
                "resourceName": "CustomersTable",
            },
            {
                "timestamp": "2025-04-13T10:35:00Z",
                "userPrincipal": "admin@example.com",
                "action": "ModifySensitivityLabel",
                "resourceType": "Column",
                "resourceName": "CustomersTable.PersonalEmailAddress",
                "oldLabel": "General",
                "newLabel": "Confidential",
            },
        ]

        return logs
    except HttpResponseError as e:
        print(f"HTTP error occurred: {str(e)}")
        return {"error": f"HTTP error occurred: {str(e)}"}
    except Exception as e:
        print(f"Error retrieving audit logs: {str(e)}")
        return {"error": f"Error retrieving audit logs: {str(e)}"}


async def process_get_sensitivity_label_changes(
    start_time: str, end_time: Optional[str] = None
) -> Dict[str, Any]:
    """
    Get a report of sensitivity label changes in the specified time period.
    """
    if not state.get("catalog_client"):
        return {"error": "Purview client not initialized correctly"}

    try:
        # Get audit logs filtered for sensitivity label changes
        logs = await process_get_audit_logs(start_time, end_time, 1000)

        if isinstance(logs, dict) and "error" in logs:
            return logs

        # Filter for sensitivity label changes
        label_changes = [
            log for log in logs if log.get("action") == "ModifySensitivityLabel"
        ]

        # Group by resource type
        grouped_changes = {}
        for change in label_changes:
            resource_type = change.get("resourceType", "Unknown")
            if resource_type not in grouped_changes:
                grouped_changes[resource_type] = []
            grouped_changes[resource_type].append(change)

        return {
            "total_changes": len(label_changes),
            "changes_by_resource": grouped_changes,
            "time_period": {
                "start": start_time,
                "end": end_time or datetime.datetime.utcnow().isoformat() + "Z",
            },
        }
    except Exception as e:
        print(f"Error processing sensitivity label changes: {str(e)}")
        return {"error": f"Error processing sensitivity label changes: {str(e)}"}


async def process_scan_data_source(
    data_source_name: str, scan_level: str = "Incremental"
) -> Dict[str, Any]:
    """
    Initiate a scan on a Purview data source.
    """
    if not state.get("scanning_client"):
        return {"error": "Purview scanning client not initialized correctly"}

    try:
        scanning_client = state.get("scanning_client")
        config = state.get("config")

        print(f"Initiating {scan_level} scan on data source: {data_source_name}")

        # In a production environment, you would use the actual API
        # scan_job = scanning_client.scans.run_scan(
        #     data_source_name=data_source_name,
        #     scan_level=scan_level
        # )

        # For demonstration purposes
        scan_job = {
            "id": f"scan-{datetime.datetime.now().strftime('%Y%m%d%H%M%S')}",
            "status": "InProgress",
            "dataSource": data_source_name,
            "scanLevel": scan_level,
            "startTime": datetime.datetime.now().isoformat(),
        }

        return {
            "message": f"{scan_level} scan initiated on {data_source_name}",
            "scan_details": scan_job,
        }
    except Exception as e:
        print(f"Error initiating scan: {str(e)}")
        return {"error": f"Error initiating scan: {str(e)}"}


async def process_get_data_catalog_summary() -> Dict[str, Any]:
    """
    Get a summary of the data catalog including asset counts by type.
    """
    if not state.get("catalog_client"):
        return {"error": "Purview client not initialized correctly"}

    try:
        catalog_client = state.get("catalog_client")

        # In a production environment, you would query the actual API
        # Example: Get counts of assets by type
        # asset_stats = catalog_client.discovery.get_asset_statistics()

        # For demonstration purposes
        asset_stats = {
            "total_assets": 1250,
            "by_type": {
                "Table": 450,
                "StorageAccount": 15,
                "SQL_Database": 25,
                "Column": 750,
                "Schema": 10,
            },
            "sensitivity_distribution": {
                "Public": 500,
                "General": 400,
                "Confidential": 300,
                "Highly Confidential": 50,
            },
            "last_updated": datetime.datetime.now().isoformat(),
        }

        return asset_stats
    except Exception as e:
        print(f"Error fetching data catalog summary: {str(e)}")
        return {"error": f"Error fetching data catalog summary: {str(e)}"}


async def process_get_data_lineage(entity_id: str, depth: int = 3) -> Dict[str, Any]:
    """
    Get data lineage information for a specific entity.
    """
    if not state.get("catalog_client"):
        return {"error": "Purview client not initialized correctly"}

    try:
        catalog_client = state.get("catalog_client")

        print(f"Fetching lineage for entity {entity_id} with depth {depth}")

        # In a production environment, you would use the actual API
        # lineage = catalog_client.lineage.get_lineage(guid=entity_id, depth=depth)

        # For demonstration purposes
        lineage = {
            "entity_id": entity_id,
            "entity_name": "SalesData",
            "entity_type": "Table",
            "nodes": [
                {"id": "node1", "name": "RawSalesData", "type": "Blob"},
                {"id": "node2", "name": "SalesDataTransform", "type": "Pipeline"},
                {"id": entity_id, "name": "SalesData", "type": "Table"},
                {"id": "node4", "name": "SalesDashboard", "type": "PowerBIReport"},
            ],
            "edges": [
                {"source": "node1", "target": "node2", "label": "input"},
                {"source": "node2", "target": entity_id, "label": "output"},
                {"source": entity_id, "target": "node4", "label": "source"},
            ],
        }

        return lineage
    except Exception as e:
        print(f"Error fetching lineage: {str(e)}")
        return {"error": f"Error fetching lineage: {str(e)}"}


async def initialize_state():
    """
    Initialize server state with Purview clients
    """
    # Load configuration from environment
    config = PurviewConfig(
        account_name=os.environ.get("PURVIEW_ACCOUNT_NAME", ""),
        endpoint=os.environ.get("PURVIEW_ENDPOINT", ""),
        subscription_id=os.environ.get("AZURE_SUBSCRIPTION_ID", ""),
        resource_group=os.environ.get("AZURE_RESOURCE_GROUP", ""),
        tenant_id=os.environ.get("AZURE_TENANT_ID", ""),
        client_id=os.environ.get("AZURE_CLIENT_ID", ""),
        client_secret=os.environ.get("AZURE_CLIENT_SECRET", ""),
    )

    # Create clients with proper authentication
    try:
        # Prefer DefaultAzureCredential for managed identity and other authentication methods
        credential = DefaultAzureCredential()

        # Fall back to client secret if needed
        if config.client_id and config.client_secret and config.tenant_id:
            credential = ClientSecretCredential(
                tenant_id=config.tenant_id,
                client_id=config.client_id,
                client_secret=config.client_secret,
            )

        # Initialize clients
        state["config"] = config
        state["catalog_client"] = PurviewCatalogClient(
            endpoint=config.endpoint, credential=credential
        )
        state["scanning_client"] = PurviewScanningClient(
            endpoint=config.endpoint, credential=credential
        )
        state["account_client"] = PurviewAccountClient(
            endpoint=config.endpoint, credential=credential
        )
        state["mgmt_client"] = PurviewManagementClient(
            credential=credential, subscription_id=config.subscription_id
        )
        state["security_client"] = SecurityCenter(
            credential=credential, subscription_id=config.subscription_id
        )

        print("Purview clients initialized successfully")
    except Exception as e:
        print(f"Error during initialization: {str(e)}")


async def main():
    """Main entry point for the MCP server"""
    # Initialize server state
    await initialize_state()

    # Run the server using stdin/stdout streams
    async with mcp.server.stdio.stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            InitializationOptions(
                server_name="str-mcp-purview",
                server_version="0.1.0",
                capabilities=server.get_capabilities(
                    notification_options=NotificationOptions(),
                    experimental_capabilities={},
                ),
            ),
        )


# Main entry point to run the server
if __name__ == "__main__":
    asyncio.run(main())
