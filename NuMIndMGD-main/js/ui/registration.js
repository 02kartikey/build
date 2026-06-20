/* ═══════════════════════════════════════════════════════════════════
   ui/registration.js  —  NuMind MAPS
   State → City → School cascading dropdowns for the registration form.

   Exported:
     initStateDropdown()   — called once on DOMContentLoaded
     populateCities()      — called by r-state onchange
     populateSchools()     — called by r-city onchange

   School data:
     Covers all 28 states + 8 UTs of India.
     Each state has its major cities; each city has a curated list of
     well-known CBSE / ICSE / State-board schools.
     Students can also type a school name not in the list by selecting
     "Other (type below)" — a free-text fallback input appears.
═══════════════════════════════════════════════════════════════════ */

'use strict';

/* ──────────────────────────────────────────────────────────────────
   DATA — India States → Cities → Schools
─────────────────────────────────────────────────────────────────── */
const INDIA_DATA = {
  "Andhra Pradesh": {
    "Visakhapatnam": ["Bhashyam Public School","DAV Public School","Delhi Public School","Kendriya Vidyalaya No.1","Little Flower High School","Narayana E-Techno School","Sri Chaitanya School","St. Joseph's English Medium School","Timpany Senior Secondary School","Vikasa School"],
    "Vijayawada": ["Bhashyam Public School","Delhi Public School","Kendriya Vidyalaya","Narayana School","Sri Chaitanya School","St. Ann's High School","St. Xavier's High School","Vivekananda High School"],
    "Guntur": ["Delhi Public School","Kendriya Vidyalaya","Narayana School","Sri Chaitanya School","St. Joseph's High School"],
    "Tirupati": ["Delhi Public School","Kendriya Vidyalaya","Narayana School","Sri Padmavathi School","Sri Venkateswara School"],
    "Nellore": ["Bhashyam School","Delhi Public School","Kendriya Vidyalaya","Narayana School"],
    "Other": []
  },
  "Arunachal Pradesh": {
    "Itanagar": ["Delhi Public School","Donyi Polo Vidyalaya","Kendriya Vidyalaya","Vivekananda Kendra Vidyalaya"],
    "Naharlagun": ["Delhi Public School","Kendriya Vidyalaya","Jawahar Navodaya Vidyalaya"],
    "Other": []
  },
  "Assam": {
    "Guwahati": ["Asian Higher Secondary School","Cotton Collegiate","Delhi Public School","Don Bosco School","Guru Nanak Higher Secondary School","Handique Girls' College","Holy Child School","Kendriya Vidyalaya","Mahatma Gandhi International School","Modern English Academy","Sainik School Goalpara","South Point School","St. Mary's Higher Secondary School"],
    "Dibrugarh": ["Don Bosco School","Kendriya Vidyalaya","St. Paul's School"],
    "Jorhat": ["Kendriya Vidyalaya","St. Paul's School","Assam Valley School"],
    "Silchar": ["Kendriya Vidyalaya","Holy Cross School","St. Paul's Higher Secondary"],
    "Other": []
  },
  "Bihar": {
    "Patna": ["Carmel High School","D.A.V. Public School","Delhi Public School","Don Bosco Academy","Kendriya Vidyalaya","Loyola High School","Notre Dame Academy","Patna High School","Sacred Heart Convent School","St. Joseph's Convent","St. Michael's High School","St. Xavier's High School"],
    "Gaya": ["Delhi Public School","Kendriya Vidyalaya","Notre Dame Academy","St. Joseph's School"],
    "Bhagalpur": ["Kendriya Vidyalaya","St. Joseph's School","Trinity High School"],
    "Muzaffarpur": ["Delhi Public School","Kendriya Vidyalaya","St. Michael's School"],
    "Other": []
  },
  "Chhattisgarh": {
    "Raipur": ["Delhi Public School","Kendriya Vidyalaya","Nalanda School","Sacred Heart School","Sri Satya Sai Vidya Vihar","St. Francis School","St. Thomas College"],
    "Bilaspur": ["Delhi Public School","Kendriya Vidyalaya","St. Xavier's School"],
    "Durg": ["Delhi Public School","Kendriya Vidyalaya","Sai Baba School"],
    "Other": []
  },
  "Goa": {
    "Panaji": ["Carmel College","Kendriya Vidyalaya","Lemon Tree English Medium School","People's High School","Rosary High School","St. Britto's High School"],
    "Margao": ["Kendriya Vidyalaya","Our Lady of Grace High School","People's English Medium School"],
    "Vasco da Gama": ["Kendriya Vidyalaya","New English High School","St. Andrew's High School"],
    "Other": []
  },
  "Gujarat": {
    "Ahmedabad": ["Adani Vidya Mandir","Delhi Public School","G.D. Goenka School","Kendriya Vidyalaya","L.P. Savani School","Navrachana International School","Nirma Vidyavihar","Rivers International School","Riverside School","Sandipani School","Shri D.N. Vyas High School","St. Kabir School","Udgam School for Children","Zydus School for Excellence"],
    "Surat": ["Delhi Public School","G.D. Goenka School","Kendriya Vidyalaya","S.N. Kansagra School","Shree Swaminarayan High School"],
    "Vadodara": ["Delhi Public School","Kendriya Vidyalaya","Navrachana International","Podar International School","The Maharaja Sayajirao University School"],
    "Rajkot": ["Delhi Public School","Kendriya Vidyalaya","Patel Vidhyalay","Royal Academy"],
    "Gandhinagar": ["Delhi Public School","Kendriya Vidyalaya","Udgam School"],
    "Other": []
  },
  "Haryana": {
    "Gurugram": ["Amity International School","Pathways School Gurgaon","Delhi Public School","G.D. Goenka World School","Heritage Xperiential Learning School","Kendriya Vidyalaya","Scottish High International School","Shri Ram School Aravali","The Shri Ram School","The Vivekananda School"],
    "Faridabad": ["Bal Bharati Public School","Delhi Public School","Kendriya Vidyalaya","Ryan International School","The Yadavindra Public School"],
    "Chandigarh (Haryana)": ["Bhavan Vidyalaya","Carmel Convent School","Kendriya Vidyalaya","St. John's High School"],
    "Hisar": ["Delhi Public School","Kendriya Vidyalaya","Om Public School"],
    "Rohtak": ["Delhi Public School","Kendriya Vidyalaya","Ryan International School"],
    "Ambala": ["Delhi Public School","Kendriya Vidyalaya","St. Helen's Convent School"],
    "Sonipat": ["Delhi Public School","Kendriya Vidyalaya","Ryan International School"],
    "Panipat": ["Delhi Public School","Kendriya Vidyalaya","Lovely Public School"],
    "Other": []
  },
  "Himachal Pradesh": {
    "Shimla": ["Auckland House School","Bishop Cotton School","Loreto Convent","Sanawarian School","St. Edward's School"],
    "Dharamsala": ["Central School for Tibetans","Kendriya Vidyalaya","St. John's School"],
    "Manali": ["Delhi Public School","Kendriya Vidyalaya"],
    "Other": []
  },
  "Jharkhand": {
    "Ranchi": ["Carmel Junior College","D.A.V. Public School","Delhi Public School","Don Bosco School","Kendriya Vidyalaya","Loyola School","St. John's School","St. Xavier's College","St. Xavier's School","Ursuline Convent School"],
    "Jamshedpur": ["Carmel Junior College","Delhi Public School","Kendriya Vidyalaya","Loyola School","Sacred Heart Convent","St. Mary's School"],
    "Dhanbad": ["Delhi Public School","Kendriya Vidyalaya","St. Paul's School"],
    "Other": []
  },
  "Karnataka": {
    "Bengaluru": ["Bishop Cotton Boys' School","Bishop Cotton Girls' School","Clarence High School","CMR National Public School","Deens Academy","Delhi Public School Bangalore East","Delhi Public School Bangalore South","Gear Innovative International School","Greenwood High International School","Indus International School","Inventure Academy","Kendriya Vidyalaya","Mallya Aditi International School","National Public School (Indiranagar)","National Public School (Rajajinagar)","New Horizon Gurukul","Podar International School","Ryan International School","Sarala Birla Gyan Peeth","Sophia High School","St. Joseph's Boys' High School","The International School Bangalore","Vidya Mandir Senior Secondary School","Whitefield Global School","Wipro Earthian","YUVABHARATHI International School"],
    "Mysuru": ["Delhi Public School","Kendriya Vidyalaya","Marimallappa's High School","St. Philomena's School","Vidya Vardhaka Sangha School"],
    "Mangaluru": ["Canara High School","Delhi Public School","Kendriya Vidyalaya","Rosario English Medium School","St. Aloysius High School"],
    "Hubballi": ["Delhi Public School","Kendriya Vidyalaya","Poornaprajna Education Centre","St. Mary's High School"],
    "Belagavi": ["Delhi Public School","Kendriya Vidyalaya","St. Paul's High School"],
    "Other": []
  },
  "Kerala": {
    "Thiruvananthapuram": ["Bhavan's Vidya Mandir","Choice School","Delhi Public School","Holy Angels ISC","Kendriya Vidyalaya","Loyola School","Mar Ivanios College HSS","Model School Pattom","St. Joseph's HSS","SNDP Higher Secondary School"],
    "Kochi": ["CCSIT School","Choice School","Chinmaya Vidyalaya","Delhi Public School","Good Shepherd International School","Holy Grace Academy","Kendriya Vidyalaya","Rajagiri Public School","Ryan International School","St. Albert's High School","St. Teresa's Girls' Higher Secondary School"],
    "Kozhikode": ["Delhi Public School","Kendriya Vidyalaya","St. Joseph's Boys' Higher Secondary School","The Oxford School","YMCA School"],
    "Thrissur": ["Bhavan's Vidya Mandir","Delhi Public School","Kendriya Vidyalaya","Our Lady's School"],
    "Palakkad": ["Delhi Public School","Kendriya Vidyalaya","Little Flower HSS"],
    "Other": []
  },
  "Madhya Pradesh": {
    "Bhopal": ["Campion School","Carmel Convent School","Delhi Public School","Kendriya Vidyalaya","St. Joseph's Co-Ed School","St. Montfort Senior Secondary School","The Sanskaar Valley School","Vidya Devi Jindal School"],
    "Indore": ["Choithram School","Delhi Public School","Kendriya Vidyalaya","MGM Higher Secondary School","Podar International School","Sanawaria International School","St. Raphael's Higher Secondary School"],
    "Gwalior": ["Delhi Public School","Kendriya Vidyalaya","Scindia School","St. George's College"],
    "Jabalpur": ["Christ Church Boys' Higher Secondary School","Delhi Public School","Kendriya Vidyalaya","Model Higher Secondary School"],
    "Other": []
  },
  "Maharashtra": {
    "Mumbai": ["Cathedral and John Connon School","Dhirubhai Ambani International School","Don Bosco High School","Greenlawns High School","H.R. College","Jamnabai Narsee School","Kendriya Vidyalaya","Lilavatibai Podar High School","M.A. Podar International School","Maneckji Cooper Education Trust School","Podar International School","Rishi Valley School","Ryan International School","St. Anne's High School","St. Mary's SSC","Symbiosis International School","The Orchid School","Vasant Vihar High School"],
    "Pune": ["Bishops Co-Ed School","Blossom English School","Brahmand English School","Christ Church School","Crawfords English High School","Delhi Public School","Lexicon International School","Mercedes-Benz International School","National Military School Pune","Orchid School","Podar International School","Rosary High School","Ryan International School","St. Vincent's High School","The Orchid School","Vibgyor High"],
    "Nagpur": ["Bhavan's B.P. Vidya Mandir","Delhi Public School","Hislop School","Kendriya Vidyalaya","St. Francis De Sales High School","St. Ursula Girls' High School"],
    "Nashik": ["Delhi Public School","K.T.H.M. College","Kendriya Vidyalaya","Podar International School","Ryan International School"],
    "Aurangabad": ["Delhi Public School","Kendriya Vidyalaya","St. Francis D'Assisi School"],
    "Thane": ["Billabong High International","Kendriya Vidyalaya","Podar International School","Ryan International School"],
    "Other": []
  },
  "Manipur": {
    "Imphal": ["Delhi Public School","Don Bosco School","Kendriya Vidyalaya","St. Joseph School","Vivekananda Higher Secondary School"],
    "Other": []
  },
  "Meghalaya": {
    "Shillong": ["Don Bosco School","Kendriya Vidyalaya","Loreto Convent School","Pine Mount School","St. Edmund's School","St. Mary's Higher Secondary School"],
    "Other": []
  },
  "Mizoram": {
    "Aizawl": ["Kendriya Vidyalaya","Mizoram Higher Secondary School","St. Paul's Higher Secondary School"],
    "Other": []
  },
  "Nagaland": {
    "Kohima": ["Kendriya Vidyalaya","Nagaland Sainik School","St. Joseph's School"],
    "Other": []
  },
  "Odisha": {
    "Bhubaneswar": ["DAV Public School","Delhi Public School","Kendriya Vidyalaya","Master Canopy International School","National Institute of Education","Prabhujee English Medium School","SAI International School","Siksha 'O' Anusandhan School","Sri Aurobindo Education Centre","Stewart School"],
    "Cuttack": ["Delhi Public School","Kendriya Vidyalaya","Ravenshaw Collegiate School","Stewart School Cuttack"],
    "Rourkela": ["Ispat English Medium School","Kendriya Vidyalaya","Sacred Heart School"],
    "Other": []
  },
  "Punjab": {
    "Chandigarh (Punjab)": ["Bhavan Vidyalaya","Carmel Convent School","Delhi Public School","Kendriya Vidyalaya","Sacred Heart School","Shivalik Public School","St. John's High School"],
    "Amritsar": ["Delhi Public School","Guru Nanak Public School","Kendriya Vidyalaya","Sacred Heart School","Spring Dale Senior School"],
    "Ludhiana": ["Delhi Public School","Kendriya Vidyalaya","Malwa Central School","Sacred Heart School"],
    "Jalandhar": ["Arya Samaj School","Delhi Public School","Kendriya Vidyalaya","Lawrence School","St. Francis School","Swami Sant Dass Public School"],
    "Patiala": ["Delhi Public School","Kendriya Vidyalaya","Yadavindra Public School"],
    "Bathinda": ["Delhi Public School","Kendriya Vidyalaya","Ryan International School"],
    "Other": []
  },
  "Rajasthan": {
    "Jaipur": ["Delhi Public School","G.D. Goenka Public School","Kendriya Vidyalaya","Mahatma Gandhi International School","Maharaja Sawai Man Singh Vidyalaya","Podar International School","Ryan International School","St. Edmund's School","St. Xavier's School","Tagore International School","The Doon International School","Vidya Bharati School"],
    "Jodhpur": ["Delhi Public School","Kendriya Vidyalaya","Neerja Modi School","Ryan International School","St. Anne's School"],
    "Udaipur": ["Delhi Public School","Kendriya Vidyalaya","Maharana Mewar Public School","St. Gregory's School"],
    "Ajmer": ["Delhi Public School","Kendriya Vidyalaya","Mayo College","St. Anselm's School"],
    "Kota": ["Delhi Public School","Kendriya Vidyalaya","Sophia Senior Secondary School"],
    "Other": []
  },
  "Sikkim": {
    "Gangtok": ["Kendriya Vidyalaya","Sikkim Government Sr. Sec. School","St. Xavier's School","Tashi Namgyal Academy"],
    "Other": []
  },
  "Tamil Nadu": {
    "Chennai": ["Balalok Matriculation Higher Secondary School","Bhavan's Rajaji Vidyashram","Chettinad Vidyashram","Chennai Public School","Chetpet Higher Secondary School","Chinmaya Vidyalaya","DAV Boys Senior Secondary School","Delhi Public School","Don Bosco Matriculation Higher Secondary School","Good Shepherd Matriculation Higher Secondary School","Kendriya Vidyalaya","PSBB Millennium School","PSBB Senior Secondary School","Padma Seshadri Bala Bhavan","PS Senior Secondary School","Rosary Matriculation Higher Secondary School","Santhome Higher Secondary School","Sri Sankara Senior Secondary School","St. Bede's Anglo Indian Higher Secondary School","St. Michael's Academy"],
    "Coimbatore": ["Chennai Public School","Chinmaya Vidyalaya","Delhi Public School","G.D. Goenka School","Kendriya Vidyalaya","SBOA School & Junior College","SNS Matriculation Higher Secondary School","Sri Ramakrishna Mission Vidyalaya"],
    "Madurai": ["American College","Delhi Public School","Kendriya Vidyalaya","Lady Doak College","St. Mary's School","St. Xavier's Higher Secondary School"],
    "Tiruchirappalli": ["Delhi Public School","Kendriya Vidyalaya","St. Joseph's Higher Secondary School","BHEL DAV Higher Secondary School"],
    "Salem": ["Delhi Public School","Kendriya Vidyalaya","Salem Higher Secondary School"],
    "Tirunelveli": ["Delhi Public School","Kendriya Vidyalaya","St. Johns HSS","St. Xavier's College"],
    "Other": []
  },
  "Telangana": {
    "Hyderabad": ["Aliya Degree College","Bhavan's Vivekananda Vidyalaya","Candor International School","Chirec International School","Delhi Public School","Glendale Academy","Greenland International School","International Grammar School","Kendriya Vidyalaya","Narayana E-Techno School","Oakridge International School","Pathfinder High School","Rockwell International School","Sancta Maria International School","Silver Oaks International School","Sri Chaitanya School","St. John's Grammar School","The Future Kids School","Vidya Niketan School"],
    "Warangal": ["Delhi Public School","Kendriya Vidyalaya","Narayana School","Sri Chaitanya School"],
    "Karimnagar": ["Delhi Public School","Kendriya Vidyalaya","Narayana School"],
    "Nizamabad": ["Delhi Public School","Kendriya Vidyalaya"],
    "Other": []
  },
  "Tripura": {
    "Agartala": ["Kendriya Vidyalaya","Maharaja Bir Bikram College","St. Paul's School","Vivekananda Vidyapith"],
    "Other": []
  },
  "Uttar Pradesh": {
    "Lucknow": ["City Montessori School (CMS) Aliganj","City Montessori School (CMS) Gomtinagar","City Montessori School (CMS) Rajajipuram","Delhi Public School","Jaipuria School Lucknow","Kendriya Vidyalaya","La Martiniere College","Loreto Convent Intermediate College","Ryan International School","Seth Anandram Jaipuria School","St. Francis College","St. Joseph's Inter College","St. Mary's Convent Inter College"],
    "Noida": ["Amity International School","Delhi Public School Noida","G.D. Goenka Public School","Genesis Global School","Kendriya Vidyalaya","Lotus Valley International School","Ryan International School","Shiv Nadar School","Step By Step School","The Millennium School"],
    "Kanpur": ["Delhi Public School","Kendriya Vidyalaya","Sacred Heart Inter College","Seth Anandram Jaipuria School","St. Aloysius","St. Joseph's College"],
    "Agra": ["Delhi Public School","Kendriya Vidyalaya","St. Conrad's Inter College","St. Peter's College"],
    "Varanasi": ["Delhi Public School","Kendriya Vidyalaya","St. John's School","Sunbeam English School","Vishwa Bharati Public School"],
    "Ghaziabad": ["Delhi Public School","DPS Indirapuram","Kendriya Vidyalaya","Ryan International School","Vidya Niketan School"],
    "Prayagraj": ["Ewing Christian College","Kendriya Vidyalaya","St. Joseph's College","St. Mary's Convent"],
    "Meerut": ["Delhi Public School","Kendriya Vidyalaya","Meerut Public School"],
    "Other": []
  },
  "Uttarakhand": {
    "Dehradun": ["Brightlands School","Colonel Brown Cambridge School","Convent of Jesus and Mary","Delhi Public School","G.D. Goenka World School","Kendriya Vidyalaya","The Doon School","The Welham Boys' School","The Welham Girls' School","Woodstock School"],
    "Haridwar": ["Delhi Public School","Kendriya Vidyalaya","Rishikul Vidyapeeth"],
    "Nainital": ["Birla Vidya Mandir","St. Mary's School","Sherwood College"],
    "Mussoorie": ["Wynberg Allen School","Landour Language School","Vincent Hill School"],
    "Other": []
  },
  "West Bengal": {
    "Kolkata": ["Assembly of God Church School","Birla High School","Calcutta International School","Don Bosco School (Park Circus)","Frank Anthony Public School","Future Foundation School","Heritage School","La Martiniere for Boys","La Martiniere for Girls","Loreto House","Loreto Day School","Modern High School for Girls","Pratt Memorial School","South Point High School","Springfield School","St. James' School","St. Paul's Cathedral Mission College","Sushila Birla Girls' School","The Heritage School","The SSKM School"],
    "Howrah": ["Delhi Public School","Kendriya Vidyalaya","South Point School"],
    "Siliguri": ["Delhi Public School","Don Bosco School","Kendriya Vidyalaya","Mount Hermon School","North Point","St. Joseph's School"],
    "Asansol": ["Delhi Public School","Kendriya Vidyalaya","St. Patrick's Higher Secondary School"],
    "Durgapur": ["Delhi Public School","Kendriya Vidyalaya","St. Xavier's English Medium School"],
    "Other": []
  },
  "Andaman and Nicobar Islands": {
    "Port Blair": ["Kendriya Vidyalaya","Jawahar Navodaya Vidyalaya","Bay Islands Higher Secondary School"],
    "Other": []
  },
  "Chandigarh": {
    "Chandigarh": ["Bhavan Vidyalaya","Carmel Convent School","Delhi Public School","Kendriya Vidyalaya","Sacred Heart School","Shivalik Public School","St. John's High School","St. Stephen's School"],
    "Other": []
  },
  "Dadra and Nagar Haveli and Daman and Diu": {
    "Daman": ["Kendriya Vidyalaya","St. Joseph's School"],
    "Silvassa": ["Kendriya Vidyalaya","Shishu Vihar School"],
    "Other": []
  },
  "Delhi": {
    "New Delhi": ["Amity International School","Bal Bharati Public School","Birla Vidya Niketan","Bluebells School International","Delhi Public School RK Puram","Delhi Public School Vasant Kunj","Don Bosco School","Father Agnel School","G.D. Goenka Public School","Hansraj Model School","Kendriya Vidyalaya","Kulachi Hansraj Model School","Laxman Public School","Lotus Valley International School","Modern School Barakhamba Road","Modern School Vasant Vihar","Mount Abu Public School","Navyug School","N.C. Jindal Public School","New Green Field School","Podar International School","Presidium School","Queen Mary's School","Rajkiya Pratibha Vikas Vidyalaya","Ryan International School","Sanskriti School","Sardar Patel Vidyalaya","Shiv Nadar School","Spring Dales School","St. Columba's School","St. Mary's School","St. Thomas' School","The Apeejay School","The Mother's International School","The Shriram School","Vasant Valley School","Venkateshwar International School"],
    "Other": []
  },
  "Jammu and Kashmir": {
    "Srinagar": ["Delhi Public School","Kendriya Vidyalaya","St. Joseph's Higher Secondary School","Tyndale Biscoe School"],
    "Jammu": ["Delhi Public School","G.D. Goenka School","Kendriya Vidyalaya","Ryan International School","St. Joseph's Higher Secondary School"],
    "Other": []
  },
  "Ladakh": {
    "Leh": ["Kendriya Vidyalaya","Jawahar Navodaya Vidyalaya"],
    "Other": []
  },
  "Lakshadweep": {
    "Kavaratti": ["Kendriya Vidyalaya","Jawahar Navodaya Vidyalaya"],
    "Other": []
  },
  "Puducherry": {
    "Puducherry": ["Kendriya Vidyalaya","Lycée Français de Pondicherry","Petit Séminaire Higher Secondary School","Sri Aurobindo International Centre of Education","Sri Narayani Higher Secondary School"],
    "Other": []
  },
};

/* ──────────────────────────────────────────────────────────────────
   HELPERS
─────────────────────────────────────────────────────────────────── */
function _el(id) { return document.getElementById(id); }

function _setOptions(select, options, placeholder) {
  select.innerHTML = '';
  const blank = document.createElement('option');
  blank.value = ''; blank.textContent = placeholder;
  select.appendChild(blank);
  options.forEach(text => {
    const o = document.createElement('option');
    o.value = text; o.textContent = text;
    select.appendChild(o);
  });
}

/* ──────────────────────────────────────────────────────────────────
   PUBLIC API
─────────────────────────────────────────────────────────────────── */

/**
 * Populate the State dropdown with all India states + UTs.
 * Call once on DOMContentLoaded.
 */
export function initStateDropdown() {
  const stateEl = _el('r-state');
  if (!stateEl) return;
  const states = Object.keys(INDIA_DATA).sort();
  _setOptions(stateEl, states, 'Select State');

  // Reset downstream selects
  const cityEl = _el('r-city');
  if (cityEl) { cityEl.disabled = true; _setOptions(cityEl, [], 'Select State first'); }

  const schEl = _el('r-sch');
  if (schEl && schEl.tagName === 'SELECT') { schEl.disabled = true; _setOptions(schEl, [], 'Select City first'); }

  _hideOther();
}

/**
 * Populate City dropdown when a State is selected.
 * Bound to r-state onchange.
 */
export function populateCities() {
  const stateEl = _el('r-state');
  const cityEl  = _el('r-city');
  if (!stateEl || !cityEl) return;

  const state = stateEl.value;
  const schEl = _el('r-sch');

  // Reset school
  if (schEl && schEl.tagName === 'SELECT') {
    schEl.disabled = true;
    _setOptions(schEl, [], 'Select City first');
  }
  _hideOther();

  if (!state || !INDIA_DATA[state]) {
    cityEl.disabled = true;
    _setOptions(cityEl, [], 'Select State first');
    return;
  }

  const cities = Object.keys(INDIA_DATA[state]).sort();
  _setOptions(cityEl, cities, 'Select City');
  cityEl.disabled = false;
}

/**
 * Populate School dropdown when a City is selected.
 * Bound to r-city onchange.
 */
export function populateSchools() {
  const stateEl = _el('r-state');
  const cityEl  = _el('r-city');
  const schEl   = _el('r-sch');
  if (!stateEl || !cityEl || !schEl) return;

  const state = stateEl.value;
  const city  = cityEl.value;
  _hideOther();

  if (!state || !city || !INDIA_DATA[state]) {
    if (schEl.tagName === 'SELECT') {
      schEl.disabled = true;
      _setOptions(schEl, [], 'Select City first');
    }
    return;
  }

  let schools = (INDIA_DATA[state][city] || []).slice().sort();

  if (schEl.tagName === 'SELECT') {
    // Add "Other (type below)" option at end
    const opts = [...schools, 'Other (type below)'];
    _setOptions(schEl, opts, 'Select School');
    schEl.disabled = false;
  }
}

export function handleSchoolChange() {
  const schEl    = _el('r-sch');
  const otherWrap = _el('r-sch-other-wrap');
  const otherInp  = _el('r-sch-other');
  if (!schEl) return;
  if (schEl.value === 'Other (type below)') {
    if (otherWrap) otherWrap.style.display = 'block';
    if (otherInp)  otherInp.focus();
  } else {
    _hideOther();
  }
}

function _hideOther() {
  const w = _el('r-sch-other-wrap');
  const i = _el('r-sch-other');
  if (w) w.style.display = 'none';
  if (i) i.value = '';
}

/**
 * Returns the final school name:
 * - If r-sch is a SELECT and value is 'Other (type below)', returns r-sch-other input value
 * - Otherwise returns r-sch value
 * Used by doRegister() in router.js.
 */
export function getSchoolValue() {
  const schEl   = _el('r-sch');
  const otherEl = _el('r-sch-other');
  if (!schEl) return '';
  if (schEl.tagName === 'SELECT' && schEl.value === 'Other (type below)') {
    return otherEl ? otherEl.value.trim() : '';
  }
  return schEl.value.trim();
}
