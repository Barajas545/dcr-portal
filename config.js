// ---------------------------------------------------------------------------
// DCR Portal configuration (safe to be public — contains NO secrets).
//
// API_BASE: your Vercel deployment URL (no trailing slash).
//
// COMPANY: all branding + company information in one place, so a different
// company can use this app by editing this block and replacing logo.png.
// Empty fields ("") are simply hidden wherever they would appear.
// The logo file lives at dcr-portal/logo.png — overwrite it to change the
// logo everywhere (a higher-resolution PNG improves printed letterheads).
// ---------------------------------------------------------------------------
window.DCR_CONFIG = {
  API_BASE: "https://share-point-api.vercel.app",

  COMPANY: {
    name: "DCR Framing",
    legalName: "DCR Framing LLC",
    logo: "logo.png",
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
