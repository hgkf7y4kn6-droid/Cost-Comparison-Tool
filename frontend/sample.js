// "Try it with sample data": a handful of clearly labeled, fictional leads so a new rep (or an app
// reviewer) can see the pipeline, fit scores, outreach drafts and the coach with something in them.
// Everything is marked sample: names say (SAMPLE), emails use the reserved .example domain, phone numbers are
// in the fictional 555-01xx range, and sample leads are never synced to the server.
(function () {
  const $ = (id) => document.getElementById(id);
  const hub = window.SalesHub;

  const SAMPLES = [
    { company: "Brightside Dental (SAMPLE)", industry: "Dental practice", employees: 34, city: "Philadelphia", state: "PA", zip: "19103", contactName: "Dana Reyes", contactTitle: "Practice Manager", email: "dana@brightside-dental.example", phone: "(215) 555-0111", website: "brightside-dental.example", stage: "verified", emailStatus: "valid" },
    { company: "Keystone Legal Group (SAMPLE)", industry: "Law firm", employees: 58, city: "Allentown", state: "PA", zip: "18101", contactName: "Marcus Lee", contactTitle: "Office Administrator", email: "marcus@keystone-legal.example", phone: "(610) 555-0122", website: "keystone-legal.example", stage: "contacted", emailStatus: "valid" },
    { company: "Harbor Property Partners (SAMPLE)", industry: "Property management", employees: 41, city: "Cherry Hill", state: "NJ", zip: "08002", contactName: "Priya Nair", contactTitle: "Facilities Manager", email: "priya@harbor-property.example", phone: "(856) 555-0133", website: "harbor-property.example", stage: "enriched", emailStatus: "unverified" },
    { company: "Lancaster Precision Tool (SAMPLE)", industry: "Manufacturing", employees: 120, city: "Lancaster", state: "PA", zip: "17601", contactName: "Tom Becker", contactTitle: "Operations Manager", email: "tom@lancaster-precision.example", phone: "(717) 555-0144", website: "lancaster-precision.example", stage: "qualified", emailStatus: "valid" },
    { company: "Maple Grove Academy (SAMPLE)", industry: "Private school", employees: 76, city: "Media", state: "PA", zip: "19063", contactName: "", contactTitle: "", email: "", phone: "(610) 555-0155", website: "maplegrove-academy.example", stage: "new", emailStatus: "unverified" },
    { company: "Delaware Valley Staffing (SAMPLE)", industry: "Staffing agency", employees: 49, city: "King of Prussia", state: "PA", zip: "19406", contactName: "Alicia Moore", contactTitle: "Office Manager", email: "alicia@dvstaffing.example", phone: "(610) 555-0166", website: "dvstaffing.example", stage: "new", emailStatus: "unverified" },
  ];

  const isSample = (l) => l.sample === true;
  const has = () => hub.state.leads.some(isSample);

  function load() {
    const added = hub.addLeads(SAMPLES.map((s) => ({ ...s, sample: true, source: "Sample data", notes: "Sample lead for trying the app. Remove it from Account." })));
    if (added.length) window.showTab("prospecting");
    return added.length;
  }

  function remove() {
    const ids = new Set(hub.state.leads.filter(isSample).map((l) => l.id));
    hub.state.leads = hub.state.leads.filter((l) => !ids.has(l.id));
    if (hub.state.activeLeadId && ids.has(hub.state.activeLeadId)) hub.state.activeLeadId = null;
    if (hub.state.activeDeal && hub.state.activeDeal.kind === "lead" && ids.has(hub.state.activeDeal.id)) hub.state.activeDeal = null;
    hub.save();
    return ids.size;
  }

  hub.sample = { load, remove, has };
  $("start-sample").addEventListener("click", load);
  $("acct-sample-remove").addEventListener("click", () => {
    if (!confirm("Remove the sample leads from this device?")) return;
    remove();
    $("acct-sample-remove").hidden = true;
  });
  $("auth-account").addEventListener("click", () => ($("acct-sample-remove").hidden = !has()));
})();
