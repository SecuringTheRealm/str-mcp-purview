"""
MCP Server for Microsoft Purview Integration

This server exposes Purview functionality as tools and resources through
the Model Context Protocol (MCP).
"""

import os
import json
import datetime
from contextlib import asynccontextmanager
from typing import List, Dict, Any, Optional
from dataclasses import dataclass

# Import MCP server components
from mcp.server.fastmcp import FastMCP, Context, Image
from dotenv import load_dotenv

# Import Azure components with security best practices
from azure.identity import DefaultAzureCredential, ClientSecretCredential
from azure.purview.catalog import PurviewCatalogClient
from azure.purview.scanning import PurviewScanningClient
from azure.purview.administration.account import PurviewAccountClient
from azure.core.exceptions import HttpResponseError

# Load environment variables
load_dotenv()

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

@asynccontextmanager
async def lifespan():
    """
    Server lifespan manager - initialize and clean up resources
    Uses async context manager pattern for strong typing
    """
    # Load configuration from environment
    config = PurviewConfig(
        account_name=os.environ.get("PURVIEW_ACCOUNT_NAME", ""),
        endpoint=os.environ.get("PURVIEW_ENDPOINT", ""),
        subscription_id=os.environ.get("AZURE_SUBSCRIPTION_ID", ""),
        resource_group=os.environ.get("AZURE_RESOURCE_GROUP", ""),
        tenant_id=os.environ.get("AZURE_TENANT_ID", ""),
        client_id=os.environ.get("AZURE_CLIENT_ID", ""),
        client_secret=os.environ.get("AZURE_CLIENT_SECRET", "")
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
                client_secret=config.client_secret
            )

        # Initialize clients
        catalog_client = PurviewCatalogClient(endpoint=config.endpoint, credential=credential)
        scanning_client = PurviewScanningClient(endpoint=config.endpoint, credential=credential)
        account_client = PurviewAccountClient(endpoint=config.endpoint, credential=credential)
        mgmt_client = PurviewManagementClient(credential=credential, subscription_id=config.subscription_id)
        security_client = SecurityCenter(credential=credential, subscription_id=config.subscription_id)

        # Make clients available to all tools and resources
        yield {
            "config": config,
            "catalog_client": catalog_client,
            "scanning_client": scanning_client,
            "account_client": account_client,
            "mgmt_client": mgmt_client,
            "security_client": security_client
        }
    except Exception as e:
        print(f"Error during initialization: {str(e)}")
        # Yield empty dict if initialization fails
        yield {}
    finally:
        # Clean up resources
        print("Shutting down Purview MCP server")

# Create MCP server with lifespan
mcp = FastMCP("Purview MCP", lifespan=lifespan)

# Define tools for Purview interaction

@mcp.tool()
async def get_audit_logs(
    start_time: str,
    end_time: Optional[str] = None,
    limit: int = 100,
    ctx: Context = None
) -> List[Dict[str, Any]]:
    """
    Retrieve audit logs from Purview for the specified time period.

    Args:
        start_time: Start time in ISO format (YYYY-MM-DDTHH:MM:SS)
        end_time: End time in ISO format (YYYY-MM-DDTHH:MM:SS), defaults to current time
        limit: Maximum number of logs to return

    Returns:
        List of audit log entries
    """
    if not ctx.state.get("catalog_client"):
        return {"error": "Purview client not initialized correctly"}

    try:
        catalog_client = ctx.state.get("catalog_client")
        security_client = ctx.state.get("security_client")

        # Format the time parameters
        if not end_time:
            end_time = datetime.datetime.utcnow().isoformat() + "Z"

        # In a real implementation, you would use the appropriate Purview API
        # This is a placeholder for demonstration
        # Example query to get audit logs, adjust according to the actual API
        query = {
            "startTime": start_time,
            "endTime": end_time,
            "limit": limit
        }

        ctx.info(f"Fetching audit logs from {start_time} to {end_time}")
        # Placeholder for actual API call
        # logs = catalog_client.audit.get_logs(query)

        # Simulated response for demonstration
        logs = [
            {
                "timestamp": "2025-04-13T10:30:00Z",
                "userPrincipal": "user@example.com",
                "action": "ViewAsset",
                "resourceType": "Table",
                "resourceName": "CustomersTable"
            },
            {
                "timestamp": "2025-04-13T10:35:00Z",
                "userPrincipal": "admin@example.com",
                "action": "ModifySensitivityLabel",
                "resourceType": "Column",
                "resourceName": "CustomersTable.PersonalEmailAddress",
                "oldLabel": "General",
                "newLabel": "Confidential"
            }
        ]

        return logs
    except HttpResponseError as e:
        ctx.error(f"HTTP error occurred: {str(e)}")
        return {"error": f"HTTP error occurred: {str(e)}"}
    except Exception as e:
        ctx.error(f"Error retrieving audit logs: {str(e)}")
        return {"error": f"Error retrieving audit logs: {str(e)}"}

@mcp.tool()
async def get_sensitivity_label_changes(
    start_time: str,
    end_time: Optional[str] = None,
    ctx: Context = None
) -> Dict[str, Any]:
    """
    Get a report of sensitivity label changes in the specified time period.

    Args:
        start_time: Start time in ISO format (YYYY-MM-DDTHH:MM:SS)
        end_time: End time in ISO format (YYYY-MM-DDTHH:MM:SS), defaults to current time

    Returns:
        Report of sensitivity label changes
    """
    if not ctx.state.get("catalog_client"):
        return {"error": "Purview client not initialized correctly"}

    try:
        # Get audit logs filtered for sensitivity label changes
        logs = await get_audit_logs(start_time, end_time, 1000, ctx)

        if isinstance(logs, dict) and "error" in logs:
            return logs

        # Filter for sensitivity label changes
        label_changes = [
            log for log in logs
            if log.get("action") == "ModifySensitivityLabel"
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
                "end": end_time or datetime.datetime.utcnow().isoformat() + "Z"
            }
        }
    except Exception as e:
        ctx.error(f"Error processing sensitivity label changes: {str(e)}")
        return {"error": f"Error processing sensitivity label changes: {str(e)}"}

@mcp.tool()
async def scan_data_source(
    data_source_name: str,
    scan_level: str = "Incremental",
    ctx: Context = None
) -> Dict[str, Any]:
    """
    Initiate a scan on a Purview data source.

    Args:
        data_source_name: Name of the data source to scan
        scan_level: Type of scan (Incremental or Full)

    Returns:
        Scan status information
    """
    if not ctx.state.get("scanning_client"):
        return {"error": "Purview scanning client not initialized correctly"}

    try:
        scanning_client = ctx.state.get("scanning_client")
        config = ctx.state.get("config")

        ctx.info(f"Initiating {scan_level} scan on data source: {data_source_name}")

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
            "startTime": datetime.datetime.now().isoformat()
        }

        return {
            "message": f"{scan_level} scan initiated on {data_source_name}",
            "scan_details": scan_job
        }
    except Exception as e:
        ctx.error(f"Error initiating scan: {str(e)}")
        return {"error": f"Error initiating scan: {str(e)}"}

@mcp.tool()
async def get_data_catalog_summary(ctx: Context = None) -> Dict[str, Any]:
    """
    Get a summary of the data catalog including asset counts by type.

    Returns:
        Summary statistics of the data catalog
    """
    if not ctx.state.get("catalog_client"):
        return {"error": "Purview client not initialized correctly"}

    try:
        catalog_client = ctx.state.get("catalog_client")

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
                "Schema": 10
            },
            "sensitivity_distribution": {
                "Public": 500,
                "General": 400,
                "Confidential": 300,
                "Highly Confidential": 50
            },
            "last_updated": datetime.datetime.now().isoformat()
        }

        return asset_stats
    except Exception as e:
        ctx.error(f"Error fetching data catalog summary: {str(e)}")
        return {"error": f"Error fetching data catalog summary: {str(e)}"}

@mcp.tool()
async def get_data_lineage(
    entity_id: str,
    depth: int = 3,
    ctx: Context = None
) -> Dict[str, Any]:
    """
    Get data lineage information for a specific entity.

    Args:
        entity_id: ID of the entity to retrieve lineage for
        depth: Depth of lineage graph to retrieve

    Returns:
        Lineage information for the entity
    """
    if not ctx.state.get("catalog_client"):
        return {"error": "Purview client not initialized correctly"}

    try:
        catalog_client = ctx.state.get("catalog_client")

        ctx.info(f"Fetching lineage for entity {entity_id} with depth {depth}")

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
                {"id": "node4", "name": "SalesDashboard", "type": "PowerBIReport"}
            ],
            "edges": [
                {"source": "node1", "target": "node2", "label": "input"},
                {"source": "node2", "target": entity_id, "label": "output"},
                {"source": entity_id, "target": "node4", "label": "source"}
            ]
        }

        return lineage
    except Exception as e:
        ctx.error(f"Error fetching lineage: {str(e)}")
        return {"error": f"Error fetching lineage: {str(e)}"}

# Define resources for Purview information

@mcp.resource("purview-overview")
async def get_purview_overview() -> str:
    """
    Provide an overview of the Purview account configuration and status.
    """
    if not ctx.state.get("account_client"):
        return "Purview client not initialized correctly."

    try:
        config = ctx.state.get("config")

        overview = f"""
        # Microsoft Purview Overview

        ## Account Information
        - **Account Name:** {config.account_name}
        - **Endpoint:** {config.endpoint}
        - **Subscription ID:** {config.subscription_id}
        - **Resource Group:** {config.resource_group}

        ## Data Estate Summary
        {json.dumps(await get_data_catalog_summary(ctx), indent=2)}

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

@mcp.resource(path="email-sensitivity-guide")
async def get_email_sensitivity_guide(ctx: Context = None) -> str:
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

# Main entry point to run the server
if __name__ == "__main__":
    mcp.run()
