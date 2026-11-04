targetScope = 'resourceGroup'

@description('Short prefix used to name Azure resources.')
@minLength(3)
@maxLength(15)
param namePrefix string = 'livemaster'

@description('Azure region for storage and Application Insights.')
param location string = resourceGroup().location

@description('Email addresses allowed to edit the journal, comma-separated.')
param globalAdminEmails string = ''

var unique = uniqueString(subscription().id, resourceGroup().id)
var appName = '${namePrefix}-${unique}'
var storageAccountName = take(toLower(replace('${namePrefix}${unique}', '-', '')), 24)
var storageConnectionString = 'DefaultEndpointsProtocol=https;AccountName=${storageAccountName};AccountKey=${storageAccount.listKeys().keys[0].value};EndpointSuffix=core.windows.net'

module storage 'modules/storage.bicep' = {
  name: 'storage-${unique}'
  params: {
    accountName: storageAccountName
    location: location
  }
}

module insights 'modules/application-insights.bicep' = {
  name: 'insights-${unique}'
  params: {
    name: '${namePrefix}-appi-${unique}'
    location: location
  }
}

module staticWebApp 'modules/static-web-app.bicep' = {
  name: 'static-web-app-${unique}'
  params: {
    name: appName
    location: 'westeurope'
    storageAccountName: storage.outputs.accountName
    storageConnectionString: storageConnectionString
    globalAdminEmails: globalAdminEmails
    applicationInsightsConnectionString: insights.outputs.connectionString
  }
}

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  #disable-next-line BCP334
  name: storageAccountName
}

output staticWebAppName string = staticWebApp.outputs.name
output staticWebAppUrl string = staticWebApp.outputs.defaultHostname
output storageAccountName string = storage.outputs.accountName
