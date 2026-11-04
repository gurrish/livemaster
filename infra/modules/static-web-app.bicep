param name string
param location string
param storageAccountName string
@secure()
param storageConnectionString string
param globalAdminEmails string
param applicationInsightsConnectionString string

resource staticWebApp 'Microsoft.Web/staticSites@2022-09-01' = {
  name: name
  location: location
  sku: {
    name: 'Free'
    tier: 'Free'
  }
  properties: {
    stagingEnvironmentPolicy: 'Enabled'
  }
}

resource functionSettings 'Microsoft.Web/staticSites/config@2022-09-01' = {
  parent: staticWebApp
  name: 'functionappsettings'
  kind: 'functionappsettings'
  properties: {
    STORAGE_MODE: 'table'
    STORAGE_ACCOUNT_NAME: storageAccountName
    STORAGE_CONNECTION_STRING: storageConnectionString
    GLOBAL_ADMIN_EMAILS: globalAdminEmails
    APPLICATIONINSIGHTS_CONNECTION_STRING: applicationInsightsConnectionString
  }
}

output name string = staticWebApp.name
output defaultHostname string = staticWebApp.properties.defaultHostname
