(function () {
  const TAG = "%c[Tinder Identity Bypass]";
  const STYLE = "color:#0f0;font-weight:bold";
  const log = (...a) => console.log(TAG, STYLE, ...a);

  log("v2.2 loaded – explicit profile.getSelf + DOM identity-step fix");

  function safeJSONParse(text) {
    try { return JSON.parse(text); } catch { return null; }
  }

  function isGraphqlUrl(url) {
    return typeof url === "string" && (url.includes("/hs/graphql") || url.includes("/hai/graphql"));
  }

  function isTrpcUrl(url) {
    return typeof url === "string" && url.includes("/api/trpc/");
  }

  function forceIdentityOnProfile(profile) {
    if (!profile || typeof profile !== "object") return false;
    let m = false;
    if (profile.hasCompletedKyc !== true) { profile.hasCompletedKyc = true; m = true; }
    if (profile.hasCompletedIdentityVerification !== true) { profile.hasCompletedIdentityVerification = true; m = true; }
    if (profile.hasSubmittedIdentityVerification !== true) { profile.hasSubmittedIdentityVerification = true; m = true; }
    if (profile.requiresIdentityVerification !== false) { profile.requiresIdentityVerification = false; m = true; }
    if (profile.hasUnverifiedStatus === true) { profile.hasUnverifiedStatus = false; m = true; }
    return m;
  }

  function patchObjectDeep(obj) {
    if (!obj || typeof obj !== "object") return false;
    let modified = false;

    // Direct identity flags anywhere
    if ("hasCompletedKyc" in obj || "hasCompletedIdentityVerification" in obj ||
        "hasSubmittedIdentityVerification" in obj || "hasUnverifiedStatus" in obj) {
      if (forceIdentityOnProfile(obj)) modified = true;
    }

    // Nested profile object (profile.getSelf shape)
    if (obj.profile && typeof obj.profile === "object") {
      if (forceIdentityOnProfile(obj.profile)) modified = true;
    }

    // browserProfile (GraphQL CurrentUserProfile)
    if (obj.browserProfile && typeof obj.browserProfile === "object") {
      if (obj.browserProfile.hasUnverifiedStatus === true) {
        obj.browserProfile.hasUnverifiedStatus = false; modified = true;
      }
      if (forceIdentityOnProfile(obj.browserProfile)) modified = true;
    }

    if (obj.hasCompletedRegularKyc === false) { obj.hasCompletedRegularKyc = true; modified = true; }
    if (obj.hasCompletedBlockingKyc === false) { obj.hasCompletedBlockingKyc = true; modified = true; }
    if (obj.shouldDisplayBlockingKYCModal === true) { obj.shouldDisplayBlockingKYCModal = false; modified = true; }
    if (typeof obj.blockingKycCurrentStatus === "string" && obj.blockingKycCurrentStatus !== "approved") {
      obj.blockingKycCurrentStatus = "approved"; modified = true;
    }

    if (obj.silentKycEligibility && typeof obj.silentKycEligibility === "object") {
      if (obj.silentKycEligibility.canUse === false) {
        obj.silentKycEligibility.canUse = true;
        obj.silentKycEligibility.hasQualifyingEducation = true;
        obj.silentKycEligibility.reason = "Approved";
        modified = true;
      }
    }

    if (obj.accessRestrictions && typeof obj.accessRestrictions === "object") {
      const r = obj.accessRestrictions;
      if (r.requiresPhoneVerification === true) { r.requiresPhoneVerification = false; modified = true; }
      if (r.requiresHaiPhoneVerification === true) { r.requiresHaiPhoneVerification = false; modified = true; }
    }

    // KYC qualification type only
    if (obj.projectRequirement && obj.projectRequirement.qualificationType === "kyc") {
      if (obj.completed === false) { obj.completed = true; modified = true; }
      if (obj.profileQualification) {
        if (obj.profileQualification.completed === false) {
          obj.profileQualification.completed = true;
          obj.profileQualification.completedAt = new Date().toISOString();
          modified = true;
        }
        const meta = obj.profileQualification.metadata && obj.profileQualification.metadata.metadata;
        if (meta) {
          if (["created", "started", "pending"].includes(meta.currentStatus)) {
            meta.currentStatus = "approved"; modified = true;
          }
          if (Array.isArray(meta.attempts)) {
            meta.attempts.forEach((a) => {
              if (["created", "started", "pending"].includes(a.currentStatus)) {
                a.currentStatus = "approved"; modified = true;
              }
            });
          }
        }
      }
    }

    // payments setup
    if ("taxInformation" in obj || "payoutMethod" in obj || "isFullySetup" in obj) {
      const now = new Date().toISOString();
      obj.taxInformation = Object.assign({
        status: "completed", completedAt: now, formType: "w9",
        taxIdentityFormStatus: "completed", tinMatchStatus: "matched", tinMatchResult: "matched",
        currentAttestation: { attestedAt: now, formType: "w9" },
      }, obj.taxInformation || {});
      obj.payoutMethod = Object.assign({
        status: "completed", completedAt: now, hasProviderAccount: true, countryCode: "US",
        needsPayoutMethodUpdate: false, taxSetupCompleted: true, connectedProviders: ["stripe"],
        defaultPayoutMethodLastFour: "4242", defaultPayoutMethodInstitutionName: "Stripe Test Bank",
        hasPayoutHistory: false,
      }, obj.payoutMethod || {});
      obj.isFullySetup = true;
      modified = true;
    }

    for (const key of Object.keys(obj)) {
      if (obj[key] && typeof obj[key] === "object") {
        if (patchObjectDeep(obj[key])) modified = true;
      }
    }
    return modified;
  }

  function processResponseJSON(json, url) {
    let modified = false;

    if (json.errors && Array.isArray(json.errors)) {
      const before = json.errors.length;
      json.errors = json.errors.filter((err) => {
        const msg = (err.message || "").toLowerCase();
        const code = err.extensions && err.extensions.code;
        return !(msg.includes("phone verification") || code === "USER_NOT_GOOD_STANDING");
      });
      if (json.errors.length !== before) {
        modified = true;
        if (json.errors.length === 0) delete json.errors;
        if (json.data === null) json.data = {};
      }
    }

    if (patchObjectDeep(json)) modified = true;

    if (isTrpcUrl(url)) {
      const items = Array.isArray(json) ? json : (json.result ? [json] : []);
      const procs = (url.match(/\/api\/trpc\/([^?]+)/) || [])[1] || "";
      const procList = procs.split(",");

      items.forEach((item, i) => {
        if (!item || !item.result || !item.result.data) return;
        const proc = (procList[i] || "").toLowerCase();
        let data = item.result.data.json;

        // Explicit: profile.getSelf
        if (proc.includes("profile.getself") || proc === "profile.getself") {
          if (data && data.profile) {
            if (forceIdentityOnProfile(data.profile)) {
              modified = true;
              log("Forced identity flags on profile.getSelf");
            }
          }
        }

        // Explicit: kyc.hasCompletedRegularKyc
        if ((proc.includes("hascompletedregularkyc") ||
             (proc.includes("kyc.") && proc.includes("hascompleted"))) && data === false) {
          item.result.data.json = true;
          modified = true;
          log("Forced", procList[i], "→ true");
        }

        if (proc.includes("blockingmodal") && data && typeof data === "object") {
          if (data.activeModal != null) { data.activeModal = null; modified = true; }
          if (data.kycDetails != null) { data.kycDetails = null; modified = true; }
        }

        if (data && typeof data === "object" && data.flagKey === "phone-verification-onboarding") {
          data.enabled = false; data.defaultValue = false; modified = true;
        }
      });

      if (url.includes("phone-verification-existing-user-multivariate-v2")) {
        try {
          const inputMatch = url.match(/[?&]input=([^&]+)/);
          if (inputMatch) {
            const inputJson = safeJSONParse(decodeURIComponent(inputMatch[1]));
            if (inputJson && typeof inputJson === "object") {
              for (const key of Object.keys(inputJson)) {
                const entry = inputJson[key];
                if (entry?.json?.flagKey === "phone-verification-existing-user-multivariate-v2") {
                  const idx = parseInt(key, 10);
                  if (!isNaN(idx) && json[idx]?.result?.data?.json) {
                    json[idx].result.data.json.value = "excluded";
                    modified = true;
                  }
                }
              }
            }
          }
        } catch (_) {}
      }
    }

    return modified;
  }

  // ---------- fetch ----------
  const originalFetch = window.fetch;
  window.fetch = new Proxy(originalFetch, {
    async apply(target, thisArg, args) {
      const resource = args[0];
      const url = resource instanceof Request ? resource.url : String(resource || "");
      const response = await Reflect.apply(target, thisArg, args);

      if (isGraphqlUrl(url) || isTrpcUrl(url)) {
        try {
          const text = await response.clone().text();
          const json = safeJSONParse(text);
          if (json && processResponseJSON(json, url)) {
            log("Patched", url.split("?")[0].replace(/https:\/\/[^/]+/, "").slice(-90));
            return new Response(JSON.stringify(json), {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            });
          }
        } catch (e) {
          console.error("[Tinder Identity Bypass] fetch error", e);
        }
      }
      return response;
    },
  });
  window.fetch.toString = () => "function fetch() { [native code] }";

  // ---------- XHR ----------
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this._bypassUrl = url;
    return originalOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    const url = this._bypassUrl || "";
    if (isGraphqlUrl(url) || isTrpcUrl(url)) {
      this.addEventListener("readystatechange", function () {
        if (this.readyState === 4 && (this.responseType === "" || this.responseType === "text")) {
          try {
            if (this._bypassDone) return;
            const json = safeJSONParse(this.responseText || this.response);
            if (json && processResponseJSON(json, url)) {
              const newText = JSON.stringify(json);
              Object.defineProperty(this, "responseText", { get: () => newText });
              Object.defineProperty(this, "response", { get: () => newText });
              this._bypassDone = true;
              log("Patched XHR", url.split("?")[0].replace(/https:\/\/[^/]+/, "").slice(-90));
            }
          } catch (e) {
            console.error("[Tinder Identity Bypass] XHR error", e);
          }
        }
      });
    }
    return originalSend.apply(this, arguments);
  };

  // ---------- DOM fallback: mark "Verify your identity" as done + clear "1 step left" ----------
  function fixIdentityUI() {
    try {
      // Sidebar item: "Verify your identity"
      document.querySelectorAll("a, button, div, span, li").forEach((el) => {
        const t = (el.textContent || "").trim();
        if (/verify your identity/i.test(t) && t.length < 80) {
          // find parent row
          let row = el.closest("a, button, [role='button'], li, div");
          if (row) {
            // mark as completed visually
            row.style.opacity = "0.55";
            row.style.pointerEvents = "none";
            // replace Required badge
            row.querySelectorAll("span, div").forEach((badge) => {
              if (/required/i.test(badge.textContent || "")) {
                badge.textContent = "Completed";
                badge.style.background = "#dcfce7";
                badge.style.color = "#166534";
              }
            });
            // turn empty circle into check if possible
            const circle = row.querySelector("svg, [class*='circle'], [class*='radio']");
            if (circle) circle.style.display = "none";
          }
        }
      });

      // Project card "1 step left" → "Ready" / hide
      document.querySelectorAll("span, div, p").forEach((el) => {
        const t = (el.textContent || "").trim();
        if (/^\d+\s+steps?\s+left$/i.test(t) || /^1 step left$/i.test(t)) {
          el.textContent = "Ready";
          el.style.color = "#166534";
        }
      });
    } catch (_) {}
  }

  // run periodically so React re-renders don't restore the UI
  setInterval(fixIdentityUI, 800);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", fixIdentityUI);
  } else {
    fixIdentityUI();
  }
})();
