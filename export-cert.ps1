$certPath = "certs\cert.pfx"
$pwd = ConvertTo-SecureString -String "password" -Force -AsPlainText

$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2
$cert.Import($certPath, $pwd, [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::Exportable)

$certPem = "-----BEGIN CERTIFICATE-----`n"
$certPem += [System.Convert]::ToBase64String($cert.RawData, [System.Base64FormattingOptions]::InsertLineBreaks)
$certPem += "`n-----END CERTIFICATE-----`n"

Set-Content -Path "certs\cert.pem" -Value $certPem -Encoding ASCII

$privateKey = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($cert)
$keyParams = $privateKey.ExportParameters($true)

$keyPem = "-----BEGIN PRIVATE KEY-----`n"
$keyBytes = $privateKey.ExportPkcs8PrivateKey()
$keyPem += [System.Convert]::ToBase64String($keyBytes, [System.Base64FormattingOptions]::InsertLineBreaks)
$keyPem += "`n-----END PRIVATE KEY-----`n"

Set-Content -Path "certs\key.pem" -Value $keyPem -Encoding ASCII

Write-Host "Certificates exported successfully:"
Write-Host "  cert.pem - $(Split-Path (Resolve-Path certs\cert.pem) -Leaf)"
Write-Host "  key.pem  - $(Split-Path (Resolve-Path certs\key.pem) -Leaf)"
