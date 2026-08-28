-- Foreground window probe (macOS).
--
-- NOT the collector. The product's collector is Rust behind ActiveWindowProvider (ADR 0002 D-11),
-- event-driven via NSWorkspace plus an AX observer. This is a measurement rig whose only job is to
-- produce real window titles so anchor extraction can be validated against reality.
--
-- It also exercises blocker B-1 for free: reading `name of front window` goes through the
-- Accessibility API, so if the permission is missing this fails in exactly the way the real
-- collector will. That makes it the cheapest possible test of the permission story — no Xcode, no
-- Rust, no bundle to sign.
--
-- Emits: bundleId TAB appName TAB windowTitle
-- On a missing Accessibility grant, the title comes back empty while the app name still works,
-- which is precisely the degraded mode ADR 0003 D-22 requires the product to support.

tell application "System Events"
	set frontApp to first application process whose frontmost is true
	set appName to name of frontApp
	try
		set appId to bundle identifier of frontApp
	on error
		set appId to appName
	end try
	try
		set winTitle to name of front window of frontApp
	on error
		set winTitle to ""
	end try
end tell

return appId & tab & appName & tab & winTitle
