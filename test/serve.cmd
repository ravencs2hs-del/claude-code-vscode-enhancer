@echo off
rem Runs test\serve.js with the Node runtime bundled in VS Code (no separate Node install needed).
set ELECTRON_RUN_AS_NODE=1
"%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe" "%~dp0serve.js" %*
