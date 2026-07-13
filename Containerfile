# Full-surface container for hosting str-mcp-purview on Azure Functions
# (Elastic Premium / Dedicated with custom container, or Azure Container Apps).
# The plain custom-handler deploy (host.json, no container) works on Flex
# Consumption but cannot carry pwsh — only the Graph label-read tools work
# there. This image adds PowerShell 7 + ExchangeOnlineManagement for the
# DLP/label-write plane via certificate app-only auth.
#
# NOTE: Microsoft documents Security & Compliance PowerShell as unsupported in
# PowerShell 7 on Linux. Verify your ExchangeOnlineManagement version against a
# live tenant before relying on the DLP plane from this (Linux) image, and set
# PURVIEW_ALLOW_UNSUPPORTED_OS=1 to get past the server's platform gate once
# you have. See README → "Platform support".

FROM mcr.microsoft.com/azure-functions/node:4-node20

# PowerShell 7 from the release tarball (distro-agnostic; pin the version).
ARG PWSH_VERSION=7.4.6
RUN apt-get update && apt-get install -y --no-install-recommends wget ca-certificates libicu-dev \
    && wget -qO /tmp/pwsh.tar.gz "https://github.com/PowerShell/PowerShell/releases/download/v${PWSH_VERSION}/powershell-${PWSH_VERSION}-linux-x64.tar.gz" \
    && mkdir -p /opt/microsoft/powershell/7 \
    && tar zxf /tmp/pwsh.tar.gz -C /opt/microsoft/powershell/7 \
    && chmod +x /opt/microsoft/powershell/7/pwsh \
    && ln -s /opt/microsoft/powershell/7/pwsh /usr/bin/pwsh \
    && rm /tmp/pwsh.tar.gz && rm -rf /var/lib/apt/lists/*

RUN pwsh -NoLogo -NoProfile -Command "Install-Module ExchangeOnlineManagement -Scope AllUsers -Force"

ENV AzureWebJobsScriptRoot=/home/site/wwwroot \
    AzureFunctionsJobHost__Logging__Console__IsEnabled=true \
    AzureWebJobsFeatureFlags=EnableMcpCustomHandlerPreview

COPY . /home/site/wwwroot
WORKDIR /home/site/wwwroot
RUN npm ci --omit=dev
