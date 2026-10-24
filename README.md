# Handshake Identity & KYC Bypass v2.1.0

Forces identity verification / KYC to completed **without** hiding projects.

### What changed in 2.1
- Removed the `CalculatedSplashPageState → READY` force (that was making the project disappear)
- No longer touches onboarding task lists or project status lists
- Still forces all identity / KYC / hasUnverifiedStatus / silentKyc flags

### Install
1. Remove the previous version
2. Load unpacked this folder
3. Hard-refresh
