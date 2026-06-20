/* ════════════════════════════════════════════════════════════════════
   js/ui-bridge.js
   Plain-script bridge: functions needed before ES modules load.
   Includes: staff menu, counsellor navigation, counsellor query form,
   AI counsellor textarea helpers, and registration dropdowns.
   Reads CSRF token from <meta name="csrf-token"> injected server-side.
════════════════════════════════════════════════════════════════════ */
(function () {
'use strict';

// Staff login dropdown toggle
function toggleStaffMenu() {
  const dd  = document.getElementById('staff-dropdown');
  const ch  = document.getElementById('staff-chevron');
  const open = dd.style.display === 'none';
  dd.style.display = open ? 'block' : 'none';
  ch.style.transform = open ? 'rotate(180deg)' : '';
}
// Close dropdown when clicking outside
document.addEventListener('click', function(e) {
  if (!document.getElementById('staff-menu-wrap').contains(e.target)) {
    document.getElementById('staff-dropdown').style.display = 'none';
    document.getElementById('staff-chevron').style.transform = '';
  }
});

// goToCounsellor — navigate to the AI counsellor page.
// Called from results page and landing page "Open AI Counsellor" buttons.
// Defined here (in a plain script) so it is available immediately,
// before any ES module (ai-counsellor.js / main.js) has finished loading.
function goToCounsellor() {
  if (typeof window.goPage === 'function') {
    window.goPage('counsellor');
  } else {
    setTimeout(function() {
      if (typeof window.goPage === 'function') window.goPage('counsellor');
    }, 200);
  }
}

// Navigate back from counsellor page — go to results if scores exist, else landing.
function goBackFromCounsellor() {
  var _S = window.S;
  var hasResults = _S && _S.cpi && _S.cpi.scores !== null && _S.nmap && _S.nmap.scores !== null;
  if (typeof window.goPage === 'function') {
    window.goPage(hasResults ? 'results' : 'landing');
  }
}

// Counsellor contact form submission (results page section)
function submitCounsellorQuery() {
  var btn = document.getElementById('cq-submit-btn');
  var name = (document.getElementById('cq-name') || {}).value || '';
  var email = (document.getElementById('cq-email') || {}).value || '';
  var message = (document.getElementById('cq-message') || {}).value || '';
  if (!name || !email || !message) return;
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  var csrfMeta    = document.querySelector('meta[name="csrf-token"]');
  var csrfToken   = csrfMeta ? csrfMeta.getAttribute('content') : '';
  var appTokenMeta= document.querySelector('meta[name="app-token"]');
  // Fallback to window._APP_TOKEN for backward compat with old server.js
  var appToken    = appTokenMeta ? (appTokenMeta.getAttribute('content')||'') : (window._APP_TOKEN||'');
  var headers     = { 'Content-Type': 'application/json' };
  if (appToken)  headers['X-App-Token']  = appToken;
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  fetch('/api/counsellor-query', {
    method: 'POST', headers: headers,
    body: JSON.stringify({ name: name, email: email, message: message })
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      var success = document.getElementById('cq-success');
      if (success) success.style.display = '';
      var form = document.getElementById('cq-form');
      if (form) form.style.display = 'none';
    })
    .catch(function() {
      if (btn) { btn.disabled = false; btn.textContent = 'Send Request'; }
    });
}

// Textarea auto-resize for AI counsellor input
function _acResizeTextarea(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 140) + 'px';
}

// Keyboard handler for AI counsellor textarea — send on Enter, newline on Shift+Enter
function _acInputKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (typeof window.acSend === 'function') window.acSend();
  }
}

// ── Registration: State → City → School cascading dropdowns ──────
// Inlined here as a plain script so it works regardless of whether
// ES modules (main.js) have finished loading or are blocked by CORS.

var _INDIA_DATA=(function(){var d={};
d["Andhra Pradesh"]={"Visakhapatnam":["Bhashyam Public School","DAV Public School","Delhi Public School","Kendriya Vidyalaya No.1","Little Flower High School","Narayana E-Techno School","Sri Chaitanya School","St. Joseph's English Medium School","Timpany Senior Secondary School","Vikasa School"],"Vijayawada":["Bhashyam Public School","Delhi Public School","Kendriya Vidyalaya","Narayana School","Sri Chaitanya School","St. Ann's High School","St. Xavier's High School","Vivekananda High School"],"Guntur":["Delhi Public School","Kendriya Vidyalaya","Narayana School","Sri Chaitanya School","St. Joseph's High School"],"Tirupati":["Delhi Public School","Kendriya Vidyalaya","Narayana School","Sri Padmavathi School","Sri Venkateswara School"],"Nellore":["Bhashyam School","Delhi Public School","Kendriya Vidyalaya","Narayana School"],"Other":[]};
d["Arunachal Pradesh"]={"Itanagar":["Delhi Public School","Donyi Polo Vidyalaya","Kendriya Vidyalaya","Vivekananda Kendra Vidyalaya"],"Naharlagun":["Delhi Public School","Kendriya Vidyalaya","Jawahar Navodaya Vidyalaya"],"Other":[]};
d["Assam"]={"Guwahati":["Asian Higher Secondary School","Cotton Collegiate","Delhi Public School","Don Bosco School","Guru Nanak Higher Secondary School","Holy Child School","Kendriya Vidyalaya","Mahatma Gandhi International School","Modern English Academy","Sainik School Goalpara","South Point School","St. Mary's Higher Secondary School"],"Dibrugarh":["Don Bosco School","Kendriya Vidyalaya","St. Paul's School"],"Jorhat":["Kendriya Vidyalaya","St. Paul's School","Assam Valley School"],"Silchar":["Kendriya Vidyalaya","Holy Cross School","St. Paul's Higher Secondary"],"Other":[]};
d["Bihar"]={"Patna":["Carmel High School","D.A.V. Public School","Delhi Public School","Don Bosco Academy","Kendriya Vidyalaya","Loyola High School","Notre Dame Academy","Sacred Heart Convent School","St. Joseph's Convent","St. Michael's High School","St. Xavier's High School"],"Gaya":["Delhi Public School","Kendriya Vidyalaya","Notre Dame Academy","St. Joseph's School"],"Bhagalpur":["Kendriya Vidyalaya","St. Joseph's School","Trinity High School"],"Muzaffarpur":["Delhi Public School","Kendriya Vidyalaya","St. Michael's School"],"Other":[]};
d["Chhattisgarh"]={"Raipur":["Delhi Public School","Kendriya Vidyalaya","Nalanda School","Sacred Heart School","Sri Satya Sai Vidya Vihar","St. Francis School","St. Thomas College"],"Bilaspur":["Delhi Public School","Kendriya Vidyalaya","St. Xavier's School"],"Durg":["Delhi Public School","Kendriya Vidyalaya","Sai Baba School"],"Other":[]};
d["Goa"]={"Panaji":["Carmel College","Kendriya Vidyalaya","People's High School","Rosary High School","St. Britto's High School"],"Margao":["Kendriya Vidyalaya","Our Lady of Grace High School","People's English Medium School"],"Vasco da Gama":["Kendriya Vidyalaya","New English High School","St. Andrew's High School"],"Other":[]};
d["Gujarat"]={"Ahmedabad":["Adani Vidya Mandir","Delhi Public School","G.D. Goenka School","Kendriya Vidyalaya","Navrachana International School","Riverside School","Sandipani School","St. Kabir School","Udgam School for Children","Zydus School for Excellence"],"Surat":["Delhi Public School","G.D. Goenka School","Kendriya Vidyalaya","Shree Swaminarayan High School"],"Vadodara":["Delhi Public School","Kendriya Vidyalaya","Navrachana International","Podar International School"],"Rajkot":["Delhi Public School","Kendriya Vidyalaya","Royal Academy"],"Gandhinagar":["Delhi Public School","Kendriya Vidyalaya","Udgam School"],"Other":[]};
d["Haryana"]={"Gurugram":["Amity International School","Delhi Public School","G.D. Goenka World School","Heritage Xperiential Learning School","Kendriya Vidyalaya","Pathways School Gurgaon","Scottish High International School","Shri Ram School Aravali","The Shri Ram School","The Vivekananda School"],"Faridabad":["Bal Bharati Public School","Delhi Public School","Kendriya Vidyalaya","Ryan International School","The Yadavindra Public School"],"Hisar":["Delhi Public School","Kendriya Vidyalaya","Om Public School"],"Rohtak":["Delhi Public School","Kendriya Vidyalaya","Ryan International School"],"Ambala":["Delhi Public School","Kendriya Vidyalaya","St. Helen's Convent School"],"Sonipat":["Delhi Public School","Kendriya Vidyalaya","Ryan International School"],"Panipat":["Delhi Public School","Kendriya Vidyalaya","Lovely Public School"],"Other":[]};
d["Himachal Pradesh"]={"Shimla":["Auckland House School","Bishop Cotton School","Loreto Convent","Sanawarian School","St. Edward's School"],"Dharamsala":["Central School for Tibetans","Kendriya Vidyalaya","St. John's School"],"Manali":["Delhi Public School","Kendriya Vidyalaya"],"Other":[]};
d["Jharkhand"]={"Ranchi":["Carmel Junior College","D.A.V. Public School","Delhi Public School","Don Bosco School","Kendriya Vidyalaya","Loyola School","St. John's School","St. Xavier's College","St. Xavier's School","Ursuline Convent School"],"Jamshedpur":["Carmel Junior College","Delhi Public School","Kendriya Vidyalaya","Loyola School","Sacred Heart Convent","St. Mary's School"],"Dhanbad":["Delhi Public School","Kendriya Vidyalaya","St. Paul's School"],"Other":[]};
d["Karnataka"]={"Bengaluru":["Bishop Cotton Boys' School","Bishop Cotton Girls' School","Clarence High School","CMR National Public School","Deens Academy","Delhi Public School Bangalore East","Delhi Public School Bangalore South","Greenwood High International School","Indus International School","Inventure Academy","Kendriya Vidyalaya","Mallya Aditi International School","National Public School (Indiranagar)","National Public School (Rajajinagar)","New Horizon Gurukul","Podar International School","Ryan International School","Sophia High School","St. Joseph's Boys' High School","The International School Bangalore","Vidya Mandir Senior Secondary School"],"Mysuru":["Delhi Public School","Kendriya Vidyalaya","Marimallappa's High School","St. Philomena's School"],"Mangaluru":["Canara High School","Delhi Public School","Kendriya Vidyalaya","Rosario English Medium School","St. Aloysius High School"],"Hubballi":["Delhi Public School","Kendriya Vidyalaya","Poornaprajna Education Centre","St. Mary's High School"],"Belagavi":["Delhi Public School","Kendriya Vidyalaya","St. Paul's High School"],"Other":[]};
d["Kerala"]={"Thiruvananthapuram":["Bhavan's Vidya Mandir","Choice School","Delhi Public School","Holy Angels ISC","Kendriya Vidyalaya","Loyola School","Model School Pattom","St. Joseph's HSS"],"Kochi":["Choice School","Chinmaya Vidyalaya","Delhi Public School","Good Shepherd International School","Kendriya Vidyalaya","Rajagiri Public School","Ryan International School","St. Albert's High School"],"Kozhikode":["Delhi Public School","Kendriya Vidyalaya","St. Joseph's Boys' Higher Secondary School","The Oxford School"],"Thrissur":["Bhavan's Vidya Mandir","Delhi Public School","Kendriya Vidyalaya"],"Palakkad":["Delhi Public School","Kendriya Vidyalaya","Little Flower HSS"],"Other":[]};
d["Madhya Pradesh"]={"Bhopal":["Campion School","Carmel Convent School","Delhi Public School","Kendriya Vidyalaya","St. Joseph's Co-Ed School","St. Montfort Senior Secondary School","The Sanskaar Valley School"],"Indore":["Choithram School","Delhi Public School","Kendriya Vidyalaya","Podar International School","St. Raphael's Higher Secondary School"],"Gwalior":["Delhi Public School","Kendriya Vidyalaya","Scindia School","St. George's College"],"Jabalpur":["Christ Church Boys' Higher Secondary School","Delhi Public School","Kendriya Vidyalaya"],"Other":[]};
d["Maharashtra"]={"Mumbai":["Cathedral and John Connon School","Dhirubhai Ambani International School","Don Bosco High School","Greenlawns High School","Jamnabai Narsee School","Kendriya Vidyalaya","Lilavatibai Podar High School","Podar International School","Ryan International School","St. Anne's High School","St. Mary's SSC","Vasant Vihar High School"],"Pune":["Bishops Co-Ed School","Christ Church School","Delhi Public School","Lexicon International School","Mercedes-Benz International School","Orchid School","Podar International School","Ryan International School","St. Vincent's High School","Vibgyor High"],"Nagpur":["Bhavan's B.P. Vidya Mandir","Delhi Public School","Hislop School","Kendriya Vidyalaya","St. Francis De Sales High School"],"Nashik":["Delhi Public School","Kendriya Vidyalaya","Podar International School","Ryan International School"],"Aurangabad":["Delhi Public School","Kendriya Vidyalaya","St. Francis D'Assisi School"],"Thane":["Billabong High International","Kendriya Vidyalaya","Podar International School","Ryan International School"],"Other":[]};
d["Manipur"]={"Imphal":["Delhi Public School","Don Bosco School","Kendriya Vidyalaya","St. Joseph School","Vivekananda Higher Secondary School"],"Other":[]};
d["Meghalaya"]={"Shillong":["Don Bosco School","Kendriya Vidyalaya","Loreto Convent School","Pine Mount School","St. Edmund's School","St. Mary's Higher Secondary School"],"Other":[]};
d["Mizoram"]={"Aizawl":["Kendriya Vidyalaya","Mizoram Higher Secondary School","St. Paul's Higher Secondary School"],"Other":[]};
d["Nagaland"]={"Kohima":["Kendriya Vidyalaya","Nagaland Sainik School","St. Joseph's School"],"Other":[]};
d["Odisha"]={"Bhubaneswar":["DAV Public School","Delhi Public School","Kendriya Vidyalaya","SAI International School","Stewart School","Sri Aurobindo Education Centre"],"Cuttack":["Delhi Public School","Kendriya Vidyalaya","Ravenshaw Collegiate School","Stewart School Cuttack"],"Rourkela":["Ispat English Medium School","Kendriya Vidyalaya","Sacred Heart School"],"Other":[]};
d["Punjab"]={"Chandigarh (Punjab)":["Bhavan Vidyalaya","Carmel Convent School","Delhi Public School","Kendriya Vidyalaya","Sacred Heart School","Shivalik Public School","St. John's High School"],"Amritsar":["Delhi Public School","Guru Nanak Public School","Kendriya Vidyalaya","Sacred Heart School","Spring Dale Senior School"],"Ludhiana":["Delhi Public School","Kendriya Vidyalaya","Malwa Central School","Sacred Heart School"],"Jalandhar":["Arya Samaj School","Delhi Public School","Kendriya Vidyalaya","Lawrence School","St. Francis School"],"Patiala":["Delhi Public School","Kendriya Vidyalaya","Yadavindra Public School"],"Bathinda":["Delhi Public School","Kendriya Vidyalaya","Ryan International School"],"Other":[]};
d["Rajasthan"]={"Jaipur":["Delhi Public School","G.D. Goenka Public School","Kendriya Vidyalaya","Maharaja Sawai Man Singh Vidyalaya","Podar International School","Ryan International School","St. Edmund's School","St. Xavier's School","Tagore International School","The Doon International School"],"Jodhpur":["Delhi Public School","Kendriya Vidyalaya","Neerja Modi School","Ryan International School","St. Anne's School"],"Udaipur":["Delhi Public School","Kendriya Vidyalaya","Maharana Mewar Public School","St. Gregory's School"],"Ajmer":["Delhi Public School","Kendriya Vidyalaya","Mayo College","St. Anselm's School"],"Kota":["Delhi Public School","Kendriya Vidyalaya","Sophia Senior Secondary School"],"Other":[]};
d["Sikkim"]={"Gangtok":["Kendriya Vidyalaya","Sikkim Government Sr. Sec. School","St. Xavier's School","Tashi Namgyal Academy"],"Other":[]};
d["Tamil Nadu"]={"Chennai":["Balalok Matriculation Higher Secondary School","Bhavan's Rajaji Vidyashram","Chettinad Vidyashram","Chinmaya Vidyalaya","DAV Boys Senior Secondary School","Delhi Public School","Don Bosco Matriculation Higher Secondary School","Kendriya Vidyalaya","PSBB Millennium School","PSBB Senior Secondary School","Padma Seshadri Bala Bhavan","PS Senior Secondary School","Sri Sankara Senior Secondary School","St. Bede's Anglo Indian Higher Secondary School","St. Michael's Academy"],"Coimbatore":["Chinmaya Vidyalaya","Delhi Public School","G.D. Goenka School","Kendriya Vidyalaya","Sri Ramakrishna Mission Vidyalaya"],"Madurai":["Delhi Public School","Kendriya Vidyalaya","St. Mary's School","St. Xavier's Higher Secondary School"],"Tiruchirappalli":["Delhi Public School","Kendriya Vidyalaya","St. Joseph's Higher Secondary School"],"Salem":["Delhi Public School","Kendriya Vidyalaya"],"Tirunelveli":["Delhi Public School","Kendriya Vidyalaya","St. Johns HSS"],"Other":[]};
d["Telangana"]={"Hyderabad":["Bhavan's Vivekananda Vidyalaya","Candor International School","Chirec International School","Delhi Public School","Glendale Academy","Greenland International School","Kendriya Vidyalaya","Narayana E-Techno School","Oakridge International School","Rockwell International School","Sancta Maria International School","Silver Oaks International School","Sri Chaitanya School","St. John's Grammar School","Vidya Niketan School"],"Warangal":["Delhi Public School","Kendriya Vidyalaya","Narayana School","Sri Chaitanya School"],"Karimnagar":["Delhi Public School","Kendriya Vidyalaya","Narayana School"],"Nizamabad":["Delhi Public School","Kendriya Vidyalaya"],"Other":[]};
d["Tripura"]={"Agartala":["Kendriya Vidyalaya","Maharaja Bir Bikram College","St. Paul's School","Vivekananda Vidyapith"],"Other":[]};
d["Uttar Pradesh"]={"Lucknow":["City Montessori School (CMS) Aliganj","City Montessori School (CMS) Gomtinagar","Delhi Public School","Jaipuria School Lucknow","Kendriya Vidyalaya","La Martiniere College","Loreto Convent Intermediate College","Ryan International School","Seth Anandram Jaipuria School","St. Francis College","St. Joseph's Inter College","St. Mary's Convent Inter College"],"Noida":["Amity International School","Delhi Public School Noida","G.D. Goenka Public School","Genesis Global School","Kendriya Vidyalaya","Lotus Valley International School","Ryan International School","Shiv Nadar School","Step By Step School","The Millennium School"],"Kanpur":["Delhi Public School","Kendriya Vidyalaya","Sacred Heart Inter College","Seth Anandram Jaipuria School","St. Joseph's College"],"Agra":["Delhi Public School","Kendriya Vidyalaya","St. Conrad's Inter College","St. Peter's College"],"Varanasi":["Delhi Public School","Kendriya Vidyalaya","St. John's School","Sunbeam English School","Vishwa Bharati Public School"],"Ghaziabad":["Delhi Public School","DPS Indirapuram","Kendriya Vidyalaya","Ryan International School"],"Prayagraj":["Ewing Christian College","Kendriya Vidyalaya","St. Joseph's College","St. Mary's Convent"],"Meerut":["Delhi Public School","Kendriya Vidyalaya","Meerut Public School"],"Other":[]};
d["Uttarakhand"]={"Dehradun":["Brightlands School","Colonel Brown Cambridge School","Convent of Jesus and Mary","Delhi Public School","G.D. Goenka World School","Kendriya Vidyalaya","The Doon School","The Welham Boys' School","The Welham Girls' School","Woodstock School"],"Haridwar":["Delhi Public School","Kendriya Vidyalaya","Rishikul Vidyapeeth"],"Nainital":["Birla Vidya Mandir","St. Mary's School","Sherwood College"],"Mussoorie":["Wynberg Allen School","Vincent Hill School"],"Other":[]};
d["West Bengal"]={"Kolkata":["Assembly of God Church School","Birla High School","Calcutta International School","Don Bosco School (Park Circus)","Frank Anthony Public School","Future Foundation School","Heritage School","La Martiniere for Boys","La Martiniere for Girls","Loreto House","Loreto Day School","Modern High School for Girls","Pratt Memorial School","South Point High School","Springfield School","St. James' School","Sushila Birla Girls' School","The Heritage School"],"Howrah":["Delhi Public School","Kendriya Vidyalaya","South Point School"],"Siliguri":["Delhi Public School","Don Bosco School","Kendriya Vidyalaya","Mount Hermon School","North Point","St. Joseph's School"],"Asansol":["Delhi Public School","Kendriya Vidyalaya","St. Patrick's Higher Secondary School"],"Durgapur":["Delhi Public School","Kendriya Vidyalaya","St. Xavier's English Medium School"],"Other":[]};
d["Andaman and Nicobar Islands"]={"Port Blair":["Kendriya Vidyalaya","Jawahar Navodaya Vidyalaya","Bay Islands Higher Secondary School"],"Other":[]};
d["Chandigarh"]={"Chandigarh":["Bhavan Vidyalaya","Carmel Convent School","Delhi Public School","Kendriya Vidyalaya","Sacred Heart School","Shivalik Public School","St. John's High School","St. Stephen's School"],"Other":[]};
d["Dadra and Nagar Haveli and Daman and Diu"]={"Daman":["Kendriya Vidyalaya","St. Joseph's School"],"Silvassa":["Kendriya Vidyalaya","Shishu Vihar School"],"Other":[]};
d["Delhi"]={"New Delhi":["Amity International School","Bal Bharati Public School","Birla Vidya Niketan","Bluebells School International","Delhi Public School RK Puram","Delhi Public School Vasant Kunj","Don Bosco School","Father Agnel School","G.D. Goenka Public School","Hansraj Model School","Kendriya Vidyalaya","Kulachi Hansraj Model School","Lotus Valley International School","Modern School Barakhamba Road","Modern School Vasant Vihar","Mount Abu Public School","Navyug School","N.C. Jindal Public School","Podar International School","Queen Mary's School","Ryan International School","Sanskriti School","Sardar Patel Vidyalaya","Shiv Nadar School","Spring Dales School","St. Columba's School","St. Mary's School","St. Thomas' School","The Apeejay School","The Mother's International School","The Shriram School","Vasant Valley School","Venkateshwar International School"],"Other":[]};
d["Jammu and Kashmir"]={"Srinagar":["Delhi Public School","Kendriya Vidyalaya","St. Joseph's Higher Secondary School","Tyndale Biscoe School"],"Jammu":["Delhi Public School","G.D. Goenka School","Kendriya Vidyalaya","Ryan International School","St. Joseph's Higher Secondary School"],"Other":[]};
d["Ladakh"]={"Leh":["Kendriya Vidyalaya","Jawahar Navodaya Vidyalaya"],"Other":[]};
d["Lakshadweep"]={"Kavaratti":["Kendriya Vidyalaya","Jawahar Navodaya Vidyalaya"],"Other":[]};
d["Puducherry"]={"Puducherry":["Kendriya Vidyalaya","Petit Séminaire Higher Secondary School","Sri Aurobindo International Centre of Education","Sri Narayani Higher Secondary School"],"Other":[]};
return d;
})();

function _regSetOptions(select, options, placeholder) {
  select.innerHTML = '';
  var blank = document.createElement('option');
  blank.value = ''; blank.textContent = placeholder;
  select.appendChild(blank);
  options.forEach(function(text) {
    var o = document.createElement('option');
    o.value = text; o.textContent = text;
    select.appendChild(o);
  });
}

function _regHideOther() {
  var w = document.getElementById('r-sch-other-wrap');
  var i = document.getElementById('r-sch-other');
  if (w) w.style.display = 'none';
  if (i) i.value = '';
}

function initStateDropdown() {
  var stateEl = document.getElementById('r-state');
  if (!stateEl) return;
  var states = Object.keys(_INDIA_DATA).sort();
  _regSetOptions(stateEl, states, 'Select State');
  var cityEl = document.getElementById('r-city');
  if (cityEl) { cityEl.disabled = true; _regSetOptions(cityEl, [], 'Select State first'); }
  var schEl = document.getElementById('r-sch');
  if (schEl) { schEl.disabled = true; _regSetOptions(schEl, [], 'Select City first'); }
  _regHideOther();
}

function populateCities() {
  var stateEl = document.getElementById('r-state');
  var cityEl  = document.getElementById('r-city');
  if (!stateEl || !cityEl) return;
  var state = stateEl.value;
  var schEl = document.getElementById('r-sch');
  if (schEl) { schEl.disabled = true; _regSetOptions(schEl, [], 'Select City first'); }
  _regHideOther();
  if (!state || !_INDIA_DATA[state]) {
    cityEl.disabled = true;
    _regSetOptions(cityEl, [], 'Select State first');
    return;
  }
  var cities = Object.keys(_INDIA_DATA[state]).sort();
  _regSetOptions(cityEl, cities, 'Select City');
  cityEl.disabled = false;
}

function populateSchools() {
  var stateEl = document.getElementById('r-state');
  var cityEl  = document.getElementById('r-city');
  var schEl   = document.getElementById('r-sch');
  if (!stateEl || !cityEl || !schEl) return;
  var state = stateEl.value;
  var city  = cityEl.value;
  _regHideOther();
  if (!state || !city || !_INDIA_DATA[state]) {
    schEl.disabled = true;
    _regSetOptions(schEl, [], 'Select City first');
    return;
  }
  var schools = (_INDIA_DATA[state][city] || []).slice().sort();
  var opts = schools.concat(['Other (type below)']);
  _regSetOptions(schEl, opts, 'Select School');
  schEl.disabled = false;
}

function handleSchoolChange() {
  var schEl = document.getElementById('r-sch');
  var otherWrap = document.getElementById('r-sch-other-wrap');
  var otherInp  = document.getElementById('r-sch-other');
  if (!schEl) return;
  if (schEl.value === 'Other (type below)') {
    if (otherWrap) otherWrap.style.display = 'block';
    if (otherInp)  otherInp.focus();
  } else {
    _regHideOther();
  }
}

function getSchoolValue() {
  var schEl   = document.getElementById('r-sch');
  var otherEl = document.getElementById('r-sch-other');
  if (!schEl) return '';
  if (schEl.value === 'Other (type below)') {
    return otherEl ? otherEl.value.trim() : '';
  }
  return schEl.value.trim();
}

document.addEventListener('DOMContentLoaded', function() {
  initStateDropdown();
});

}());
