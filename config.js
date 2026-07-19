// ---------------------------------------------------------------------------
// DCR Portal configuration (safe to be public — contains NO secrets).
//
// API_BASE: your Vercel deployment URL (no trailing slash).
//
// COMPANY: all branding + company information in one place, so a different
// company can use this app by editing this block and replacing the logo file.
// Empty fields ("") are simply hidden wherever they would appear.
// `logo` drives login, Home, and all printed report letterheads (all shown on
// white) — point it at a high-resolution image for sharp printing. The dark
// Tasks-on-Map top bar separately uses a transparent logo.png (it inverts the
// artwork to white), so keep that file if you rebrand.
// ---------------------------------------------------------------------------
window.DCR_CONFIG = {
  API_BASE: "https://share-point-api.vercel.app",

  COMPANY: {
    name: "DCR Framing",
    legalName: "DCR Framing LLC",
    logo: "logo.jpg",
    address: "7075 Morro Road, Atascadero, CA 93422",
    phone: "(805) 423-8640",
    fax: "",                     // e.g. "(805) 555-0124"
    email: "daniel@dcrframing.com",
    website: "www.dcrframing.com",
    license: "CA Lic. #1043050",
  },

  // Back-compat (older pages read this):
  COMPANY_NAME: "DCR Framing",
};
