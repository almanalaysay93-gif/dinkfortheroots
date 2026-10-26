// Tournament terms: explicit agreement for each registration, separate from privacy consent.
let accepted = false;
let prompted = false;

export function ensureTerms() {
  if (accepted && document.getElementById("termsAgreement").checked) return true;
  openTerms();
  document.getElementById("termsAgreement-err").textContent = "Read and agree to the tournament terms before submitting.";
  return false;
}

export function resetTerms() {
  accepted = false;
  prompted = false;
  document.getElementById("termsAgreement").checked = false;
}

function openTerms() {
  const dialog = document.getElementById("termsDialog");
  prompted = true;
  if (!dialog.open) {
    dialog.showModal();
    dialog.querySelector(".terms__body").scrollTop = 0;
  }
}

export function initTerms() {
  const dialog = document.getElementById("termsDialog");
  const checkbox = document.getElementById("termsAgreement");
  document.getElementById("reviewTerms").addEventListener("click", openTerms);
  document.getElementById("acceptTerms").addEventListener("click", () => {
    accepted = true;
    checkbox.checked = true;
    document.getElementById("termsAgreement-err").textContent = "";
    dialog.close();
  });
  dialog.querySelectorAll("[data-close-terms]").forEach((button) => {
    button.addEventListener("click", () => dialog.close());
  });
  checkbox.addEventListener("change", () => {
    if (!checkbox.checked) accepted = false;
    else if (!accepted) { checkbox.checked = false; openTerms(); }
  });
  const promptOnce = () => {
    if (!prompted && document.getElementById("closedNote").hidden) openTerms();
  };
  document.getElementById("regForm").addEventListener("focusin", promptOnce);
  document.querySelectorAll('a[href="#register"]').forEach((link) => link.addEventListener("click", promptOnce));
  if (location.hash === "#register") promptOnce();
}
