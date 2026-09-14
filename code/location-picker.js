// Framework-free continent-checkboxes + dual-listbox country picker, shared
// by Settings' Location Filter (6.13, settings.html/js) and the onboarding
// wizard's Location step (Phase 2, onboarding.html/js) - extracted from
// settings.js, which had this exact ~350-line widget built once already.
// The two call sites differ only in *when* they persist a change (Settings
// auto-saves mode/continent picks immediately but stages country picks
// behind its own explicit Save button and dirty-tracking; onboarding just
// reads the current value once, on "Next") - that decision stays with each
// caller via the two separate change callbacks below, never made here.
//
// `els` - the five/six DOM elements this widget owns:
//   modeSelect, continentsWrap (containing .location-continent-checkbox
//   inputs), search, available (<select multiple>), selected
//   (<select multiple>), addBtn, removeBtn, countEl (optional).
// `countryList` - the countries offered in the "available" column (e.g.
//   ALL_COUNTRIES for Location Filter, geo-urn-map.js's CONFIRMED_COUNTRIES
//   for onboarding).
// `onCountriesChange(value)` - fires after any add/remove to the country
//   list. `onModeOrContinentChange(value)` - fires after the mode select or
//   a continent checkbox changes. Both optional, both receive the same
//   shape getValue() returns.
export function mountLocationPicker(els, countryList, { onCountriesChange, onModeOrContinentChange } = {}) {
  let selectedCountries = [];

  function getValue() {
    return {
      mode: els.modeSelect.value,
      continents: Array.from(els.continentsWrap.querySelectorAll(".location-continent-checkbox:checked")).map((cb) => cb.value),
      countries: [...selectedCountries],
    };
  }

  function renderModeVisibility() {
    els.continentsWrap.style.display = els.modeSelect.value === "continent" ? "" : "none";
    els.countriesWrap.style.display = els.modeSelect.value === "country" ? "" : "none";
  }

  function renderCountryLists() {
    const query = els.search.value.trim().toLowerCase();
    const selectedSet = new Set(selectedCountries);

    els.available.innerHTML = "";
    for (const country of countryList) {
      if (selectedSet.has(country)) continue;
      if (query && !country.toLowerCase().includes(query)) continue;
      const option = document.createElement("option");
      option.value = country;
      option.textContent = country;
      els.available.appendChild(option);
    }

    els.selected.innerHTML = "";
    for (const country of [...selectedCountries].sort((a, b) => a.localeCompare(b))) {
      const option = document.createElement("option");
      option.value = country;
      option.textContent = country;
      els.selected.appendChild(option);
    }
    if (els.countEl) els.countEl.textContent = String(selectedCountries.length);
  }

  function addCountries(countries) {
    const toAdd = countries.filter((c) => !selectedCountries.includes(c));
    if (toAdd.length === 0) return;
    selectedCountries = [...selectedCountries, ...toAdd];
    renderCountryLists();
    onCountriesChange?.(getValue());
  }

  function removeCountries(countries) {
    const before = selectedCountries.length;
    const toRemove = new Set(countries);
    selectedCountries = selectedCountries.filter((c) => !toRemove.has(c));
    if (selectedCountries.length === before) return;
    renderCountryLists();
    onCountriesChange?.(getValue());
  }

  function setValue(config) {
    els.modeSelect.value = config?.mode || "off";
    for (const cb of els.continentsWrap.querySelectorAll(".location-continent-checkbox")) {
      cb.checked = (config?.continents || []).includes(cb.value);
    }
    selectedCountries = [...(config?.countries || [])];
    renderModeVisibility();
    renderCountryLists();
  }

  els.modeSelect.addEventListener("change", () => {
    renderModeVisibility();
    onModeOrContinentChange?.(getValue());
  });
  for (const cb of els.continentsWrap.querySelectorAll(".location-continent-checkbox")) {
    cb.addEventListener("change", () => onModeOrContinentChange?.(getValue()));
  }
  els.search.addEventListener("input", renderCountryLists);
  els.addBtn.addEventListener("click", () => {
    addCountries(Array.from(els.available.selectedOptions).map((o) => o.value));
  });
  els.removeBtn.addEventListener("click", () => {
    removeCountries(Array.from(els.selected.selectedOptions).map((o) => o.value));
  });
  els.available.addEventListener("dblclick", (e) => {
    if (e.target.tagName === "OPTION") addCountries([e.target.value]);
  });
  els.selected.addEventListener("dblclick", (e) => {
    if (e.target.tagName === "OPTION") removeCountries([e.target.value]);
  });

  renderModeVisibility();
  renderCountryLists();

  return { getValue, setValue };
}
