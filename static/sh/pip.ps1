[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

cd "#APPDIR#"
./python.exe -E -s -m ensurepip -U --default-pip | Out-Null
Write-Output "$([char]0x1b)[0m"
