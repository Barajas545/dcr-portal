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
    address: "",                 // e.g. "123 Main St, Paso Robles, CA 93446"
    phone: "",                   // e.g. "(805) 555-0123"
    fax: "",                     // e.g. "(805) 555-0124"
    email: "cristobal@dcrframing.com",
    website: "www.dcrframing.com",
    license: "",                 // e.g. "CA Lic. #1234567"
  },

  // Back-compat (older pages read this):
  COMPANY_NAME: "DCR Framing",
};
