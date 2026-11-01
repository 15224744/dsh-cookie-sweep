' cookie-sweep sentinel (wscript, GUI subsystem: no console window)
' NOTE: keep this file ASCII-only. WSH reads .vbs as ANSI when there is no BOM,
'       and UTF-8 Chinese comments can break parsing with a bogus "Loop without Do".
' args: 0 = pids (comma)  1 = node exe  2 = helper.mjs  3 = log file
'       4 = timeout hours  5 = sweep root  6 = process name (optional, reference only)
'
' v0.2.0 exit rule (safety first):
'   - pids gone AND app name gone for GRACE seconds  -> sweep
'   - app name comes back while waiting (quick relaunch) -> exit, no sweep
'   - app name never goes away (stuck process) -> give up after GIVEUP seconds
'   - never sweep while any process of the app is alive
Option Explicit

Dim pids, nodeExe, helper, logFile, timeoutHours, rootDir, procName
Dim shell, fso, locator, svc, startTime, alive, nameAlive, goneSince, pidList, i, col
Dim sawNameGone
pids = WScript.Arguments(0)
nodeExe = WScript.Arguments(1)
helper = WScript.Arguments(2)
logFile = WScript.Arguments(3)
timeoutHours = CInt(WScript.Arguments(4))
rootDir = WScript.Arguments(5)
procName = ""
If WScript.Arguments.Count > 6 Then procName = WScript.Arguments(6)

Const GRACE = 45
Const GIVEUP = 90

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
Set locator = WScript.CreateObject("WbemScripting.SWbemLocator")
Set svc = locator.ConnectServer(".", "root\cimv2")
startTime = Now()
goneSince = 0
sawNameGone = False
pidList = Split(pids, ",")

Log "sentinel start (v0.2.0 safe), watching " & pids & " (+" & procName & "), timeout " & timeoutHours & "h"

Do
  WScript.Sleep 2000
  alive = False

  For i = 0 To UBound(pidList)
    If Trim(pidList(i)) <> "" Then
      Set col = svc.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE ProcessId=" & Trim(pidList(i)))
      If col.Count > 0 Then alive = True
    End If
  Next

  nameAlive = False
  If procName <> "" Then
    Set col = svc.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name='" & procName & "'")
    If col.Count > 0 Then nameAlive = True
  End If

  If alive Then
    goneSince = 0
    sawNameGone = False
  Else
    If Not nameAlive Then
      sawNameGone = True
      If goneSince = 0 Then
        goneSince = Now()
        Log "app gone, waiting " & GRACE & "s to be sure"
      ElseIf GoneSeconds(goneSince) >= GRACE Then
        DoSweep
      End If
    Else
      If sawNameGone Then
        Log "app came back while waiting, exit without sweep"
        WScript.Quit 0
      End If
      If goneSince = 0 Then
        goneSince = Now()
        Log "pids gone but app name alive, waiting up to " & GIVEUP & "s"
      ElseIf GoneSeconds(goneSince) >= GIVEUP Then
        Log "app still running after " & GIVEUP & "s, exit without sweep"
        WScript.Quit 0
      End If
    End If
  End If

  If DateDiff("n", startTime, Now()) >= timeoutHours * 60 Then
    Log "sentinel timeout, exit"
    WScript.Quit 0
  End If
Loop

Sub DoSweep()
  Dim sweepCmd
  Log "targets gone, sweeping"
  sweepCmd = """" & nodeExe & """ """ & helper & """ apply --root """ & rootDir & """"
  On Error Resume Next
  shell.Run sweepCmd, 0, True
  If Err.Number <> 0 Then Log "helper failed: " & Err.Description
  On Error GoTo 0
  Log "sentinel done"
  WScript.Quit 0
End Sub

Function GoneSeconds(sinceTime)
  If IsEmpty(sinceTime) Then
    GoneSeconds = 0
  ElseIf Not IsDate(sinceTime) Then
    GoneSeconds = 0
  Else
    GoneSeconds = DateDiff("s", sinceTime, Now())
  End If
End Function

Sub Log(text)
  On Error Resume Next
  Dim stream
  Set stream = fso.OpenTextFile(logFile, 8, True)
  stream.WriteLine FormatDateTime(Now(), 2) & " " & FormatDateTime(Now(), 4) & " [vbs] " & text
  stream.Close
End Sub
