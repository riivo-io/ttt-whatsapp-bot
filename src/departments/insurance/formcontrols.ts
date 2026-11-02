// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/formcontrols.ts (commit d9e4ce7). Do not edit here:
// change the source and run scripts/sync-insurance-package.sh. Replaced by the shared package in TTTFG-4830.
// TTTFG-5562: how each question is answered on the guided form. Tapping comes first: a free-text box only where the client
// has to give a name, a number or their own words, and a voice recording only for those own words. The question list's
// wording stays for WhatsApp; this is the form's way of asking the same thing, and what it saves is a value the chat's own
// checks accept (test/claims-guided-controls.test.ts tries every option against every go-live form, and fails on a text,
// number or date question with no control here).

export type FormControl =
  /** One option to tap. `other`: "Other" opens a box. `detail`: a box for more, once one is tapped, saved as "<option><joiner><text>". */
  | { kind: 'pills'; options: readonly string[]; other?: boolean; label?: string; bare?: boolean; detail?: { placeholder: string; joiner: string } }
  /** Any of the options, saved as "a, b". */
  | { kind: 'multi'; options: readonly string[]; other?: boolean; label?: string; bare?: boolean }
  /**
   * Yes or no; the box shows only on yes. `no`: what "no" saves. `long`: the client's own words, so they can record it too.
   * `needsText`: the form's box wants the thing itself (a number, a name), so yes with nothing typed is a blank, not "Yes".
   */
  | { kind: 'yes-text'; label: string; then: string; no?: string; long?: boolean; bare?: boolean; needsText?: boolean }
  | { kind: 'slider'; min: number; max: number; step: number; unit: string; label?: string; bare?: boolean }
  /** `recent`: Today and Yesterday to tap first. `month`: a month and a year are enough. */
  | { kind: 'date'; recent?: boolean; month?: boolean; label?: string }
  | { kind: 'time'; label?: string }
  /** A date and, if the client knows it, a time, in one text answer. */
  | { kind: 'datetime'; label?: string }
  | { kind: 'year'; label?: string }
  /** The number of people in a repeating group: it answers the yes/no and the group's "is there another?" questions. */
  | { kind: 'stepper'; group: string; label: string; none: string; one: string; many: string }
  /** An amount in rand. */
  | { kind: 'amount'; label?: string; bare?: boolean; placeholder?: string }
  /** A box for what can't be tapped: a name, a registration. `half`: shares a row with the next. */
  | { kind: 'short'; label?: string; placeholder?: string; half?: boolean; bare?: boolean }
  /** The client's own words: typed or recorded. */
  | { kind: 'long'; label?: string };

const pills = (options: readonly string[], o: Omit<Extract<FormControl, { kind: 'pills' }>, 'kind' | 'options'> = {}): FormControl => ({ kind: 'pills', options, ...o });
const multi = (options: readonly string[], o: Omit<Extract<FormControl, { kind: 'multi' }>, 'kind' | 'options'> = {}): FormControl => ({ kind: 'multi', options, ...o });
const yesText = (label: string, then: string, o: Omit<Extract<FormControl, { kind: 'yes-text' }>, 'kind' | 'label' | 'then'> = {}): FormControl => ({ kind: 'yes-text', label, then, ...o });
const short = (placeholder?: string, o: Omit<Extract<FormControl, { kind: 'short' }>, 'kind' | 'placeholder'> = {}): FormControl => ({ kind: 'short', ...(placeholder ? { placeholder } : {}), ...o });
/** A box inside a person's or an item's card: the placeholder says what it is, so it needs no question above it. */
const card = (placeholder: string, half = false): FormControl => ({ kind: 'short', placeholder, bare: true, ...(half ? { half } : {}) });
const AMOUNT: FormControl = { kind: 'amount' };
const RECENT: FormControl = { kind: 'date', recent: true };
const DATE: FormControl = { kind: 'date' };
const MONTH: FormControl = { kind: 'date', month: true };
const TIME: FormControl = { kind: 'time' };
const YEAR: FormControl = { kind: 'year' };
const NAME = short();
const FIRST = short('First name', { half: true });
const SURNAME = short('Surname', { half: true });
const PHONE = short('Phone number');

const KM: FormControl = { kind: 'slider', min: 0, max: 400000, step: 5000, unit: 'km' };
const YEARS: FormControl = { kind: 'slider', min: 0, max: 30, step: 1, unit: 'years', bare: true };
const WHERE_ON_CAR = ['Front', 'Rear', 'Left side', 'Right side', 'Bonnet', 'Boot', 'Roof'];
const INSURERS = ['Santam', 'OUTsurance', 'Discovery Insure', 'Old Mutual Insure', 'Hollard', 'Momentum', 'MiWay', 'King Price', 'Auto & General'];
const insurer = (label: string): FormControl => pills(INSURERS, { other: true, label, detail: { placeholder: 'Policy number (if you have it)', joiner: ', policy ' } });
const KIN = ['Spouse', 'Child', 'Parent', 'Friend', 'Employee'];
const KNOWS = ['Family', 'Neighbour', 'Domestic worker', 'Friend', 'Security company'];
const SEEN_FROM = ['Home', 'Work', 'A shop'];
const ROOM_IN = ['Front door', 'Back door', 'Window', 'Garage', 'Roof'];
const ARMED = ['Fidelity ADT', 'Chubb', 'Beagle Watch'];
const CAR_MAKES = ['Toyota', 'VW', 'Ford', 'Hyundai', 'Nissan', 'Kia', 'Isuzu', 'Suzuki', 'Renault', 'BMW', 'Mercedes-Benz', 'Audi', 'Haval', 'Chery', 'Mazda', 'Honda'];
const COLOURS = ['White', 'Silver', 'Grey', 'Black', 'Blue', 'Red'];
const SHOPS = ['Takealot', 'Makro', 'Game', 'Incredible', 'Hi-Fi Corp', 'iStore', 'Woolworths', 'A gift'];
const ITEMS = ['TV', 'Laptop', 'Cellphone', 'Tablet', 'Camera', 'Jewellery', 'Watch', 'Bicycle', 'Furniture', 'Appliance'];
const itemControl = (): FormControl => pills(ITEMS, { other: true, label: 'What is the item?', detail: { placeholder: 'Make and model, e.g. Samsung 55 inch', joiner: ': ' } });
const shopControl = (): FormControl => pills(SHOPS, { other: true, label: 'Where did you buy it or get it?' });
const makeAndModel = (label: string): FormControl => pills(CAR_MAKES, { other: true, label, detail: { placeholder: 'Model, e.g. Polo Vivo', joiner: ' ' } });
const REPAIRER = ['Dealer', 'Workshop'];
const LIVES_AT = ['At work', 'On holiday', 'Out shopping', 'Visiting someone'];
const BUILDING_PARTS = ['Roof', 'Ceilings', 'Walls', 'Floors', 'Windows', 'Doors', 'Gate motor', 'Garage door'];

export const FORM_CONTROLS: Readonly<Record<string, FormControl>> = {
  // ---- the generic list's general questions: what Tina's walkthrough asks on chat, filled in from it when she has
  description: { kind: 'long', label: 'What happened? Tell us in your own words.' },
  incidentCause: pills(['An accident', 'Theft or burglary', 'Fire', 'Storm or flood', 'Burst pipe or geyser'], { other: true }),
  incidentAt: { kind: 'datetime', label: 'When did it happen?' },
  place: short('e.g. 12 Oak Avenue, Durbanville', { label: 'Where did it happen?' }),
  whatDamaged: multi(['Vehicle', 'House or building', 'Furniture', 'Electronics', 'Jewellery', 'Clothing', 'Tools or equipment'], { other: true, label: 'What was lost or damaged?' }),
  estimatedCost: pills(['Under R5 000', 'R5 000 to R20 000', 'R20 000 to R50 000', 'R50 000 to R100 000', 'Over R100 000'], { label: 'Roughly how much to fix or replace it?' }),

  // ---- the vehicle
  vehicleMake: pills(CAR_MAKES, { other: true }),
  vehicleModel: short('e.g. Corolla Cross'),
  vehicleMakeModel: makeAndModel('What is the make and model of the car?'),
  vehicleRegistration: short('e.g. CA 123-456'),
  registeredOwner: NAME,
  titleHolder: pills(['The person it is registered to'], { other: true, label: 'Who owns the car outright (the title holder)?' }),
  ownerRelationship: pills(KIN, { other: true }),
  yearModel: YEAR,
  vehicleYear: YEAR,
  kmReading: KM,
  vehicleMileage: KM,
  vehicleColour: pills(COLOURS, { other: true }),
  interiorColour: pills(['Black', 'Grey', 'Beige', 'Brown'], { other: true }),
  vehicleUse: pills(['Private trip', 'Driving to work', 'Business'], { other: true }),
  vehicleMarks: yesText('Does the car have any marks, scratches or dents?', 'What and where?', { long: true }),
  vehicleFeatures: yesText('Does the car have anything that makes it easy to recognise, like stickers, a roof rack or special wheels?', 'Please describe it', { long: true }),
  vehicleExtras: yesText('Did the car have any extras added after you bought it?', 'Which ones? e.g. mag wheels or a tow bar'),
  accessoriesStolen: multi(['Radio', 'Mag wheels', 'Tow bar', 'Spare wheel', 'Canopy'], { other: true }),
  engineNumber: NAME,
  vinNumber: NAME,
  stickersWhere: multi(WHERE_ON_CAR, { other: true }),
  dentsWhere: multi(WHERE_ON_CAR, { other: true }),
  scratchesWhere: multi(WHERE_ON_CAR, { other: true }),
  stickersDescribe: pills(['Brand or dealer', 'Sports team', 'Business name', 'Licence or permit'], { other: true, label: 'What are the stickers?' }),
  dentsDescribe: pills(['Small', 'Large', 'Several'], { other: true, label: 'What are the dents like?' }),
  scratchesDescribe: pills(['Light', 'Deep', 'Several'], { other: true, label: 'What are the scratches like?' }),

  // ---- the driver and their licence
  driverName: NAME,
  driverFirstName: short('First name', { half: true, label: "The driver's name (or the last person who used the car)" }),
  driverSurname: SURNAME,
  driverIdNumber: NAME,
  driverPhone: PHONE,
  driverOccupation: NAME,
  driverOwnerRelationship: pills(['Owner', ...KIN], { other: true }),
  driverRelationship: pills(KIN, { other: true }),
  alcoholDetails: pills(['One or two drinks, earlier', 'More than two drinks, earlier', 'Just before driving'], { other: true, label: 'How much, and when?' }),
  driverPhysicalDefects: yesText('Does the driver have any physical condition that affects driving, for example needing glasses?', 'What is it?'),
  licenceNumber: NAME,
  licenceCode: pills(['A1', 'A', 'B', 'EB', 'C1', 'C', 'EC1', 'EC']),
  licenceDateIssued: DATE,
  licenceEndorsements: yesText("Are there any endorsements or restrictions on the driver's licence?", 'What are they?', { no: 'None' }),
  policyholderRelationship: pills(KIN, { other: true }),

  // ---- the trip and the accident
  tripFrom: pills(SEEN_FROM, { other: true }),
  tripTo: pills(SEEN_FROM, { other: true }),
  tripPurpose: pills(['Work', 'Shopping', 'Visiting family', 'School run'], { other: true }),
  timeAtLocation: pills(['Under 1 hour', '1 to 3 hours', '3 to 8 hours', 'Overnight', 'Longer']),
  passengersReason: pills(['Family', 'Colleagues', 'Lift club', 'Friends'], { other: true }),
  passengersRelationship: pills(['Family', 'Friends', 'Colleagues'], { other: true }),
  speedBefore: { kind: 'slider', min: 0, max: 160, step: 5, unit: 'km/h', label: 'Roughly how fast was the car going just before the accident?' },
  speedAtCollision: { kind: 'slider', min: 0, max: 160, step: 5, unit: 'km/h', label: 'And roughly how fast at the moment of the crash?' },
  weather: pills(['Clear', 'Cloudy', 'Rain', 'Fog', 'Wind', 'Hail']),
  visibility: pills(['Good', 'Poor', 'Dark / night', 'Blinded by the sun']),
  roadSurface: pills(['Dry', 'Wet', 'Gravel', 'Potholes', 'Oil / diesel']),
  precautions: multi(['Braked', 'Swerved', 'Hooted', 'Nothing was possible'], { other: true }),
  additionalInfo: yesText('Is there anything else the insurer should know?', 'Please tell us', { long: true }),
  damageDescription: multi(['No damage', 'Front bumper', 'Rear bumper', 'Bonnet', 'Boot', 'Windscreen', 'Left side', 'Right side', 'Headlights', 'Tail lights', 'Roof'], { other: true, label: 'Which parts of the car are damaged?' }),
  damagedParts: multi(['No damage', 'Front bumper', 'Rear bumper', 'Bonnet', 'Boot', 'Windscreen', 'Left side', 'Right side', 'Headlights', 'Tail lights', 'Roof'], { other: true, label: 'Which parts of the car are damaged?' }),

  // ---- the other vehicle and the people in it
  otherVehicle: makeAndModel('What make and model was the other car?'),
  otherVehicleMake: makeAndModel('What make and model was the other car?'),
  otherRegistration: card('Registration number'),
  otherContact: card('Phone number or email'),
  otherInsurer: insurer('Which insurance company is the other driver with?'),
  otherInsurance: insurer('Which insurance company is the other driver with?'),
  otherInsuranceDetails: insurer('Which insurance company are they with?'),
  otherDamage: multi(['Front', 'Rear', 'Left side', 'Right side', 'Windscreen', 'Property, not a car'], { other: true, label: 'What was damaged?' }),
  otherDriverName: NAME,
  otherDriverPhone: PHONE,
  otherDriverAddress: NAME,
  otherFirstName: card('First name', true),
  otherSurname: card('Surname', true),
  otherIdNumber: yesText('Do you have their ID or passport number?', 'ID or passport number', { needsText: true }),
  otherPhone: card('Phone number'),
  otherAddress: yesText('Was their property (not a car) damaged?', 'What is the address?', { needsText: true }),
  otherInterestDetails: pills(['A bank', 'Spouse or partner', 'Landlord', 'Employer'], { other: true, label: 'Who is it?' }),
  otherInterestName: pills(['A bank', 'Spouse or partner', 'Landlord', 'Employer'], { other: true, label: 'Who is it?' }),

  // ---- people: a card each, with what can be tapped as options
  passengerName: card('Name'),
  passengerPhone: card('Contact number'),
  passengerInjury: pills(['Not hurt', 'Minor', 'Needed treatment'], { bare: true }),
  injuredName: card('Name'),
  injuredDetails: pills(['Minor', 'Went to hospital'], { other: true, bare: true }),
  injuredRelationship: pills(['Driver', 'Passenger', 'Other driver', 'Pedestrian'], { bare: true }),
  witnessName: card('Name'),
  witnessFirstName: card('First name', true),
  witnessSurname: card('Surname', true),
  witnessPhone: card('Contact number'),
  witnessRelationship: pills(['Stranger', 'Family', 'Friend', 'Colleague'], { bare: true }),

  // ---- finance, tracking, keys and history
  financeInstitution: pills(['WesBank', 'MFC (Nedbank)', 'Absa Vehicle Finance', 'Standard Bank'], { other: true }),
  financeAgreementType: pills(['Instalment sale', 'Lease', 'Balloon payment'], { label: 'What kind of finance is it?' }),
  financeAccountNumber: NAME,
  financeSettlementAmount: AMOUNT,
  trackerCompany: pills(['Tracker', 'Netstar', 'Cartrack', 'Matrix', 'Beame'], { other: true }),
  trackerMake: pills(['Tracker', 'Netstar', 'Cartrack', 'Matrix', 'Beame'], { other: true }),
  trackerDateFitted: MONTH,
  trackerNotifiedTime: TIME,
  trackerType: pills(['Early warning', 'Stolen vehicle recovery'], { other: true }),
  keysWith: multi(['I have the keys', 'I have the spare', 'The keys were stolen', 'Someone else has them'], { other: true, label: 'Where are the car keys and the spare?' }),
  keySets: pills(['1', '2', '3', '4']),
  keysReplacedBy: pills(['Dealer', 'Locksmith'], { other: true }),
  keysReplacedDate: MONTH,
  advertisedWhere: pills(['AutoTrader', 'Facebook', 'Cars.co.za', 'Gumtree'], { other: true }),
  lastServiced: MONTH,
  lastServicedBy: pills(REPAIRER, { other: true }),
  lastServicedWhere: NAME,
  lastServicedKm: KM,
  careName: NAME,
  carePhone: PHONE,
  theftLocationOther: NAME,

  // ---- where, when and the police
  incidentSuburb: short('e.g. Durbanville, Cape Town'),
  incidentCountry: pills(['South Africa', 'Namibia', 'Botswana', 'Eswatini', 'Lesotho', 'Mozambique', 'Zimbabwe'], { other: true }),
  dateDiscovered: RECENT,
  sapsCaseNumber: short('e.g. CAS 112/11/2026'),
  sapsStation: NAME,
  sapsDateReported: RECENT,
  sapsReportedBy: NAME,
  investigatingOfficer: yesText('Do you know the name of the police officer handling the case?', "The officer's name", { needsText: true }),
  sapsPhone: yesText("Do you have the police station's phone number?", 'Phone number', { needsText: true }),

  // ---- where the vehicle is
  vehicleLocation: pills(['At home', 'At a repairer', 'At a tow yard'], { other: true, label: 'Where is the car now?', detail: { placeholder: 'Name and address, if it is not at home', joiner: ': ' } }),
  vehicleLocationName: NAME,
  vehicleLocationAddress: NAME,
  vehicleLocationPhone: PHONE,
  towCompany: NAME,
  towDriver: NAME,
  towPhone: PHONE,

  // ---- household: the items
  itemDescription: itemControl(),
  itemAge: pills(['Under 1 year', '1 to 2 years', '3 to 5 years', '6 to 10 years', 'Over 10 years'], { label: 'About how old is it?' }),
  itemFrom: shopControl(),
  itemDateAcquired: MONTH,
  itemPurchaseAmount: { kind: 'amount', bare: true, placeholder: 'What you paid for it' },
  itemAmountClaimed: { kind: 'amount', bare: true, placeholder: 'What it costs to replace today' },
  itemValue: { kind: 'amount', bare: true, placeholder: 'What it costs to replace today' },
  estimateTotal: AMOUNT,
  contentsItem: itemControl(),
  contentsFrom: shopControl(),
  contentsAmount: { kind: 'amount', bare: true, placeholder: 'What you paid for it' },
  contentsAge: { ...YEARS, label: 'About how old is it?' },
  specifiedItem: itemControl(),
  specifiedFrom: shopControl(),
  specifiedAmount: { kind: 'amount', bare: true, placeholder: 'What you paid for it' },
  specifiedAge: { ...YEARS, label: 'About how old is it?' },
  unspecifiedItem: itemControl(),
  unspecifiedFrom: shopControl(),
  unspecifiedAmount: { kind: 'amount', bare: true, placeholder: 'What you paid for it' },
  unspecifiedAge: { ...YEARS, label: 'About how old is it?' },
  recoveredItem: itemControl(),
  recoveredLocation: pills(['At the police station', 'Back home'], { other: true }),
  blacklistReference: NAME,

  // ---- household: the home and how it happened
  buildingTypeOther: NAME,
  tenantName: NAME,
  tenantPhone: PHONE,
  unoccupiedFrom: DATE,
  unoccupiedTo: DATE,
  premisesLastOccupied: { kind: 'datetime' },
  premisesLeftDate: RECENT,
  premisesLeftTime: TIME,
  whereWereYou: pills(LIVES_AT, { other: true }),
  entryPoint: pills(ROOM_IN, { other: true }),
  exitPoint: pills(ROOM_IN, { other: true }),
  enteredOtherDetails: NAME,
  suspectFirstName: FIRST,
  suspectSurname: SURNAME,
  suspectPhone: yesText('Do you have their phone number?', 'Phone number', { needsText: true }),
  suspectRelationship: pills(['Stranger', ...KNOWS], { other: true }),
  thirdPartyName: NAME,
  thirdPartyPhone: PHONE,
  theftDiscovererFirstName: FIRST,
  theftDiscovererSurname: SURNAME,
  theftDiscovererPhone: PHONE,
  theftDiscovererRelationship: pills(KNOWS, { other: true }),
  fireDiscovererFirstName: FIRST,
  fireDiscovererSurname: SURNAME,
  fireDiscovererPhone: PHONE,
  fireDiscovererRelationship: pills(KNOWS, { other: true }),
  otherSecurity: yesText('Any other security?', 'What is it?', { no: 'None' }),
  armedResponseCompany: pills(ARMED, { other: true }),
  armedResponsePhone: PHONE,
  fireArmedResponseCompany: pills(ARMED, { other: true }),
  fireArmedResponsePhone: PHONE,
  fireCause: pills(['Electrical', 'Cooking', 'Lightning', 'Candle or paraffin', 'Arson'], { other: true }),
  fireOrigin: pills(['Kitchen', 'Lounge', 'Bedroom', 'Garage', 'Outside'], { other: true }),
  firePremisesLeftDate: RECENT,
  firePremisesLeftTime: TIME,
  fireWhereWereYou: pills(LIVES_AT, { other: true }),
  impactDriverFirstName: FIRST,
  impactDriverSurname: SURNAME,
  impactDriverPhone: PHONE,
  impactDriverInsurance: insurer('Which insurance company are they with?'),
  impactVehicleRegistration: short('e.g. CA 123-456'),
  impactOwnerFirstName: FIRST,
  impactOwnerSurname: SURNAME,
  impactOwnerPhone: PHONE,
  impactOwnerInsurance: insurer('Which insurance company are they with?'),
  treeCompany: NAME,
  treeContactFirstName: FIRST,
  treeContactSurname: SURNAME,
  treeContactPhone: PHONE,
  treeFellerInsurance: insurer('Which insurance company are they with?'),
  geyserTypeOther: NAME,
  damagedAreas: multi(BUILDING_PARTS, { other: true, label: 'Which parts of the building were damaged or stolen?' }),
  resultantDamageDetails: multi(['Ceilings', 'Walls', 'Floors', 'Carpets', 'Furniture', 'Electronics'], { other: true }),
  previousInsurer: pills(['This is my first', ...INSURERS], { other: true }),
  previousLosses: yesText('Have you had a similar loss or claim in the last 5 years?', 'Roughly when, what happened and how much?', { long: true }),
};

/** The yes/no that a repeating group's card count answers, when the form has that group. */
export const FORM_STEPPERS: Readonly<Record<string, Extract<FormControl, { kind: 'stepper' }>>> = {
  hadPassengers: { kind: 'stepper', group: 'passengers', label: 'Was anyone else in the vehicle?', none: 'Only the driver', one: 'passenger', many: 'passengers' },
};

/**
 * The question's words on the form: the question and nothing else, because a screen only holds what fits. The first page
 * says to leave blank what they don't know, what they tap is the answer, and an example goes in the box (formHint).
 */
export function formPrompt(prompt: string, control?: FormControl): string {
  if (control && 'label' in control && control.label) return control.label;
  const end = prompt.indexOf('?');
  const p = end >= 0 ? prompt.slice(0, end + 1) : prompt.replace(/\s*(Say "[^"]*"|For example)[^.?!]*[.?!]?/gi, '').trim();
  return control?.kind === 'multi' && !/choose any/i.test(p) ? `${p} (choose any)` : p;
}

/** What goes in an empty box: the prompt's example, or what it asks for. Nothing when there's no short way to say it. */
export function formHint(prompt: string, control?: FormControl): string | undefined {
  if (control && !['short', 'number'].includes(control.kind)) return undefined;
  if (control && 'placeholder' in control && control.placeholder) return undefined;
  const end = prompt.indexOf('?');
  if (end < 0) return undefined;
  const rest = prompt.slice(end + 1).replace(/\s*Say "[^"]*"[^.?!]*[.?!]?/gi, '').trim();
  const hint = rest.replace(/^For example,?\s*/i, 'e.g. ').replace(/^Please give\s+/i, '').replace(/\.$/, '').trim();
  if (!hint || hint.length > 40) return undefined;
  return hint.startsWith('e.g.') ? hint : hint.charAt(0).toUpperCase() + hint.slice(1);
}
