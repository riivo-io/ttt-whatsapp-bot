// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/formcontrols.ts (commit 62f588b). Do not edit here:
// change the source and run scripts/sync-insurance-package.sh. Replaced by the shared package in TTTFG-4830.
// TTTFG-5562: how each question is answered on the guided form. Tapping comes first: a free-text box only where the client
// has to give a name, a number or their own words, and a voice recording only for those own words. The question list's
// wording stays for WhatsApp; this is the form's way of asking the same thing, and what it saves is a value the chat's own
// checks accept (test/claims-guided-controls.test.ts tries every option against every go-live form, and fails on a text,
// number or date question with no control here).
import type { MasterFormId } from './masterforms';

export type FormControl =
  /** One option to tap. `other`: "Other" opens a box. `detail`: a box for more, once one is tapped, saved as "<option><joiner><text>". */
  | { kind: 'pills'; options: readonly string[]; other?: boolean; label?: string; bare?: boolean; detail?: { placeholder: string; joiner: string } }
  /**
   * A list too long to tap, of things people know the name of: a dropdown they can also type into, which narrows as they
   * type. `free`: a name that isn't on the list is kept as typed. `detail`: as for pills.
   */
  | { kind: 'combo'; options: readonly string[]; free?: boolean; label?: string; bare?: boolean; placeholder?: string; detail?: { placeholder: string; joiner: string } }
  /**
   * Any of the options, saved as "a, b". `say`: a box under the options, always open, for the rest in the client's own
   * words, typed or recorded; what's in it is saved after the options, as "Other" would be.
   */
  | { kind: 'multi'; options: readonly string[]; other?: boolean; label?: string; bare?: boolean; say?: string }
  /**
   * The parts of a car, tapped on a drawing of one seen from above, with what's picked listed under it. Saved as a multi
   * is ("Bonnet, Windscreen"); `none` is a button of its own that clears the rest, and Other opens a box.
   */
  | { kind: 'car'; options: readonly string[]; none: string; other?: boolean; label?: string }
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
  /**
   * The number of people in a repeating group: it answers the yes/no and the group's "is there another?" questions.
   * `min` 1: a count with no yes/no in front of it (the items claimed for), which starts at one and saves only the
   * "is there another?" answers.
   */
  | { kind: 'stepper'; group: string; label: string; none: string; one: string; many: string; min?: number }
  /** An amount in rand. */
  | { kind: 'amount'; label?: string; bare?: boolean; placeholder?: string }
  /** A box for what can't be tapped: a name, a registration. `half`: shares a row with the next. */
  | { kind: 'short'; label?: string; placeholder?: string; half?: boolean; bare?: boolean }
  /** The client's own words: typed or recorded. */
  | { kind: 'long'; label?: string };

const pills = (options: readonly string[], o: Omit<Extract<FormControl, { kind: 'pills' }>, 'kind' | 'options'> = {}): FormControl => ({ kind: 'pills', options, ...o });
const multi = (options: readonly string[], o: Omit<Extract<FormControl, { kind: 'multi' }>, 'kind' | 'options'> = {}): FormControl => ({ kind: 'multi', options, ...o });
const combo = (options: readonly string[], o: Omit<Extract<FormControl, { kind: 'combo' }>, 'kind' | 'options'> = {}): FormControl => ({ kind: 'combo', options, free: true, ...o });
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
const INSURERS = ['1st for Women', 'Absa Insurance', 'AIG', 'Auto & General', 'Budget Insurance', 'Bryte', 'Clientele', 'Dial Direct', 'Discovery Insure', 'First for Women', 'FNB Insurance', 'Hollard', 'Hybrid', 'iTOO', 'King Price', 'MiWay', 'Momentum', 'Mutual & Federal', 'Naked', 'Nedbank Insurance', 'Old Mutual Insure', 'OUTsurance', 'Pineapple', 'Renasa', 'Santam', 'Sasria', 'Standard Bank Insurance', 'Virseker', 'Western National', 'Zurich'];
const insurer = (label: string): FormControl => combo(INSURERS, { label, placeholder: 'Choose or type the insurer', detail: { placeholder: 'Policy number (if you have it)', joiner: ', policy ' } });
const KIN = ['Spouse', 'Child', 'Parent', 'Friend', 'Employee'];
const KNOWS = ['Family', 'Neighbour', 'Domestic worker', 'Friend', 'Security company'];
const SEEN_FROM = ['Home', 'Work', 'A shop'];
const ROOM_IN = ['Front door', 'Back door', 'Window', 'Garage', 'Roof'];
const ARMED = ['Fidelity ADT', 'Chubb', 'Beagle Watch'];
const CAR_MAKES = ['Alfa Romeo', 'Aston Martin', 'Audi', 'Bentley', 'BMW', 'BYD', 'Chana', 'Changan', 'Chery', 'Chevrolet', 'Chrysler', 'Citroen', 'Daihatsu', 'Datsun', 'Dodge', 'DFSK', 'Ferrari', 'Fiat', 'Ford', 'Foton', 'GAC', 'Geely', 'GWM', 'Haval', 'Honda', 'Hummer', 'Hyundai', 'Infiniti', 'Isuzu', 'Iveco', 'JAC', 'Jaguar', 'Jeep', 'Jetour', 'Kia', 'Lamborghini', 'Land Rover', 'Lexus', 'Mahindra', 'Maserati', 'Mazda', 'McLaren', 'Mercedes-Benz', 'MG', 'Mini', 'Mitsubishi', 'Nissan', 'Omoda', 'Opel', 'Peugeot', 'Porsche', 'Proton', 'Renault', 'Rolls-Royce', 'Saab', 'Seat', 'Smart', 'Ssangyong', 'Subaru', 'Suzuki', 'Tata', 'Tesla', 'Toyota', 'Volkswagen (VW)', 'Volvo'];
const COLOURS = ['White', 'Silver', 'Grey', 'Black', 'Red', 'Blue'];
const SHOPS = ['A gift', 'Apple Store', 'Builders', 'Cash Crusaders', 'Dis-Chem', 'Game', 'Hi-Fi Corp', 'Incredible', 'iStore', 'Jet', 'Makro', 'Mr Price', 'Pick n Pay', 'Sportsmans Warehouse', 'Takealot', 'Woolworths'];
const ITEMS = ['Appliance', 'Bicycle', 'Camera', 'Cellphone', 'Clothing', 'Furniture', 'Gaming console', 'Jewellery', 'Laptop', 'Power tool', 'Sound system', 'Sunglasses', 'Tablet', 'TV', 'Watch'];
const itemControl = (): FormControl => combo(ITEMS, { label: 'What is the item?', placeholder: 'Choose or type the item', detail: { placeholder: 'Make and model, e.g. Samsung 55 inch', joiner: ': ' } });
const shopControl = (): FormControl => combo(SHOPS, { label: 'Where did you buy it or get it?', placeholder: 'Choose or type the shop' });
const makeAndModel = (label: string): FormControl => combo(CAR_MAKES, { label, placeholder: 'Choose or type the make', detail: { placeholder: 'Model, e.g. Polo Vivo', joiner: ' ' } });
const REPAIRER = ['Dealer', 'Workshop'];
const LIVES_AT = ['At work', 'On holiday', 'Out shopping', 'Visiting someone'];
const BUILDING_PARTS = ['Roof', 'Ceilings', 'Walls', 'Floors', 'Windows', 'Doors', 'Gate motor', 'Garage door'];
/** The banks and finance houses that finance cars in South Africa, as people know them. */
const FINANCE_HOUSES = ['Absa Vehicle Finance', 'BMW Financial Services', 'Capitec', 'FNB', 'Ford Credit', 'Investec', 'Mercedes-Benz Financial Services', 'MFC (Nedbank)', 'Nedbank', 'SA Taxi Finance', 'Standard Bank', 'Toyota Financial Services', 'Volkswagen Financial Services', 'WesBank'];
/** The parts the car drawing names (the page draws each). */
export const CAR_PARTS = ['Front bumper', 'Rear bumper', 'Bonnet', 'Boot', 'Windscreen', 'Rear window', 'Left side', 'Right side', 'Headlights', 'Tail lights', 'Roof'] as const;
const CAR: FormControl = { kind: 'car', options: CAR_PARTS, none: 'No damage', other: true, label: 'Where is the car damaged? Tap each part on the drawing.' };

/** 9 Nov 2026: how the guided form asks what the claim forms of 13 more insurers ask and the go-live forms don't. */
const INSURER_CONTROLS: Record<string, FormControl> = {
  clientOccupation: { kind: 'short', placeholder: 'e.g. Teacher' },
  occupiedByWhom: { kind: 'short', placeholder: 'Full name' },
  thirdPartyAddress: { kind: 'short', placeholder: 'Address' },
  previousLossDetails: { kind: 'long', label: 'Roughly when, and what happened?' },
  previousLossInsurer: { kind: 'combo', options: INSURERS, free: true, label: 'Which insurance company paid for it?', placeholder: 'Choose or type the insurer' },
  coveredElsewhereInsurer: { kind: 'combo', options: INSURERS, free: true, label: 'Which insurance company is it with?', placeholder: 'Choose or type the insurer' },
  lastValued: { kind: 'date', month: true },
  oldDamage: yesText('Did the car have any damage before this?', 'What and where?', { no: 'None', long: true }),
  driverAddress: { kind: 'short', placeholder: 'Street, suburb and town' },
  licenceExpiry: { kind: 'date', month: true },
  driverOwnInsurer: insurer('Which insurance company is the driver\'s own car insurance with?'),
  driverOwnPolicyNo: { kind: 'short', placeholder: 'Policy number' },
  driverPreviousAccidents: yesText('Has the driver had any accidents before?', 'Roughly when, and what happened?', { no: 'No', long: true }),
  driverConvictions: yesText('Has the driver ever been convicted of a traffic offence?', 'What was it?', { no: 'No' }),
  passengerAddress: { kind: 'short', placeholder: 'Address', bare: true },
  injuredHospital: { kind: 'short', placeholder: 'Hospital, or none', bare: true },
  otherColour: pills(COLOURS, { other: true, bare: true }),
  propertyOwner: { kind: 'short', placeholder: "Owner\'s name and address", bare: true },
  propertyDamage: { kind: 'short', placeholder: 'What was damaged?', bare: true },
  witnessAddress: { kind: 'short', placeholder: 'Address', bare: true },
  roadWidth: pills(['One lane each way', 'Two lanes each way', 'More than two'], { other: true }),
  vehicleLights: pills(['Headlights', 'Dipped lights', 'None (daylight)'], { other: true }),
  streetLighting: pills(['Daylight', 'Good', 'Poor', 'No street lights']),
  warningGiven: yesText('Did anyone in your car give a warning, like hooting or flashing the lights?', 'What did they do?', { no: 'No' }),
  windowMarkingsNumber: { kind: 'short', placeholder: 'The number etched on the windows' },
  windowMarkingsBy: pills(['The dealer', 'A security company'], { other: true }),
  notLockedReason: { kind: 'long', label: 'Why was the car not locked?' },
  premisesOccupiedBy: { kind: 'short', placeholder: 'Who was there?' },
  unitsDamaged: { kind: 'slider', min: 1, max: 20, step: 1, unit: 'units' },
  sectionNumber: { kind: 'short', placeholder: 'Body corporate section number' },
  unitNumber: { kind: 'short', placeholder: 'Unit number' },
  geyserRepairDetails: { kind: 'long', label: 'What was repaired?' },
  floorsDamage: { kind: 'yes-text', label: 'Did the water damage the floors or carpets?', then: 'What damage was done?', no: 'No damage' },
  ceilingDamage: { kind: 'yes-text', label: 'Did the water damage the ceiling?', then: 'What damage was done?', no: 'No damage' },
  cupboardsDamage: { kind: 'yes-text', label: 'Did the water damage the cupboards?', then: 'What damage was done?', no: 'No damage' },
  payeeName: { kind: 'short', placeholder: 'Full name of the person or company to be paid' },
  bankName: { kind: 'combo', options: ['Absa', 'Capitec', 'FNB', 'Investec', 'Nedbank', 'Standard Bank', 'TymeBank'], free: true, placeholder: 'Choose or type the bank' },
  bankBranch: { kind: 'short', placeholder: 'Branch code' },
  bankAccount: { kind: 'short', placeholder: 'Account number' },
  vehiclePurchaseDate: { kind: 'date', month: true },
  vehiclePurchasePrice: { kind: 'amount' },
  occupation: { kind: 'short', placeholder: 'e.g. teacher, or what your business does' },
  licencePlaceIssued: { kind: 'short', placeholder: 'Town where it was issued' },
  driverOtherVehicle: { kind: 'yes-text', label: 'Does the driver own another vehicle?', then: 'Whose name is it insured under, and the policy number?', no: 'No' },
  passengerAge: card('Age'),
  otherOwnerDriver: { kind: 'short', placeholder: 'Full name and address (the owner too, if different)' },
  damagedPropertyItem: pills(['Wall', 'Gate', 'Fence', 'Pole or sign', 'Building'], { other: true, bare: true }),
  damagedPropertyOwner: card('Owner name and address'),
  damagedPropertyDamage: card('What damage was done?'),
  injuredAge: card('Age'),
  vehicleNotLockedReason: { kind: 'pills', options: ['I forgot to lock it', 'The central locking did not work', 'The car was left running'], other: true },
  itemLocation: pills(['At home', 'At a repairer', 'With the supplier'], { other: true, label: 'Where is the damaged item now?', detail: { placeholder: 'Name and address, if it is not at home', joiner: ': ' } }),
  itemLocationPhone: short('Phone number'),
  driverEmail: { kind: 'short', placeholder: 'Email address' },
  passengerEmail: { kind: 'short', placeholder: 'Email address', bare: true },
  otherDriverNameAddress: { kind: 'short', placeholder: 'Full name and address' },
  otherOwnerNameAddress: { kind: 'short', placeholder: 'Name and address, or "the driver"' },
  propertyOwnerName: { kind: 'short', placeholder: 'Owner\'s name and phone number' },
  propertyDamageDetails: { kind: 'short', placeholder: 'What was damaged' },
  witnessEmail: { kind: 'short', placeholder: 'Email address', bare: true },
  streetLightsOn: { kind: 'pills', options: ['All of them', 'Some of them', 'None', 'Daylight'], other: true },
  assessmentLocation: { kind: 'short', placeholder: 'Place or address' },
  faultWhy: { kind: 'long' },
  vehiclePricePaid: { kind: 'amount' },
  vehicleHiddenMarks: { kind: 'yes-text', label: 'Did you mark the car in a hidden way?', then: 'What and where?', long: true },
  trackerFittedBy: { kind: 'short', placeholder: 'Who fitted it' },
  windowMarkingNumber: { kind: 'yes-text', label: 'Is a number marked on the windows?', then: 'What is the number?', needsText: true },
  windowMarkingBy: { kind: 'short', placeholder: 'Who marked the windows' },
  driverAge: { kind: 'slider', min: 16, max: 90, step: 1, unit: 'years' },
  repairerName: { kind: 'short', placeholder: 'Repairer or glass company' },
  repairEstimate: { kind: 'amount' },
  coveredElsewhereDetails: { kind: 'short', placeholder: 'Insurer and policy number' },
  driverConsentDetails: { kind: 'long' },
  driverDefectDetails: { kind: 'short', placeholder: 'e.g. needs glasses' },
  licenceEndorsementDetails: { kind: 'short', placeholder: 'What the endorsements are' },
  otherSignwriting: { kind: 'short', placeholder: 'Writing on the car, or "no"' },
  witnessLocation: { kind: 'pills', options: ['In a car', 'At the roadside', 'At home or work', 'Walking'], other: true },
  injuredPhone: { kind: 'short', placeholder: 'Phone number', bare: true },
  warningDetails: { kind: 'pills', options: ['Hooted', 'Flashed the lights', 'Indicated'], other: true },
  breathalyserResult: { kind: 'pills', options: ['Below the limit', 'Over the limit'], other: true },
  vehicleExtrasDetails: { kind: 'long', label: 'What extras does it have? For example mag wheels, a tow bar or a sound system.' },
  vehicleMarksDetails: { kind: 'long', label: 'What are the marks, and where on the car?' },
  securityDevices: { kind: 'multi', options: ['Tracker', 'Alarm', 'Immobiliser', 'Steering lock', 'Gear lock'], other: true },
  vehicleUnlockedReason: { kind: 'long' },
  premisesOccupants: { kind: 'short', placeholder: 'Who was at home' },
  vehicleEntryHow: { kind: 'pills', options: ['Smashed window', 'Unlocked door', 'Forced the lock'], other: true },
  itemsPlacement: { kind: 'pills', options: ['On the back seat', 'On the front seat', 'In the boot', 'In the glove box'], other: true },
  itemsOwnedByOtherDetails: { kind: 'short', placeholder: 'Who owns which items' },
  responsibleDetails: { kind: 'long' },
  principalDriverOther: { kind: 'short', placeholder: 'Full name' },
  injuredInCarName: card('Name'),
  injuredInCarDetails: pills(['Minor', 'Went to hospital'], { other: true, bare: true }),
  injuredInCarHospital: { kind: 'short', placeholder: 'Hospital, or none', bare: true },
  otherYear: short('e.g. 2018', { label: 'What year is the other car?' }),
  otherOwnerName: card('Name of the owner'),
  otherOwnerAddress: { kind: 'short', placeholder: "Owner\'s address" },
  propertyOwnerAddress: card('Address of the owner'),
  lostControlDetails: { kind: 'long' },
  tyresChangedWhich: { kind: 'multi', options: ['Front left', 'Front right', 'Back left', 'Back right'], other: true },
  damageRepairedDetails: { kind: 'long' },
  sapsTimeReported: { kind: 'time' },
  assistReference: { kind: 'short', placeholder: 'Reference number' },
  towAuthorisedBy: { kind: 'short', placeholder: 'Full name' },
  coveredElsewherePolicyNo: { kind: 'short', placeholder: 'Policy number' },
  vehicleAlterations: yesText('Has anything on the car been changed or altered since you bought it?', 'What was changed?', { long: true }),
  antiTheftMake: { kind: 'short', placeholder: 'e.g. Tracker or Ctrack' },
  antiTheftDateFitted: { kind: 'date', month: true },
  antiTheftFittedBy: { kind: 'short', placeholder: 'Who fitted it' },
  lossCauseOther: { kind: 'short', placeholder: 'What was the cause?' },
  fireExtinguisherServiced: { kind: 'date', month: true },
  itemsRepairedDetails: { kind: 'long' },
  whoWasHome: { kind: 'pills', options: ['Me', 'My spouse or partner', 'A tenant', 'A domestic worker', 'A family member'], other: true },
  occupantName: { kind: 'short', placeholder: 'Full name' },
  occupantPhone: { kind: 'short', placeholder: 'Phone number' },
  discovererName: { kind: 'short', placeholder: 'Full name' },
  discovererIdNumber: { kind: 'short', placeholder: 'ID number' },
  discovererPhone: { kind: 'short', placeholder: 'Phone number' },
  recentRepairsDetails: { kind: 'long' },
  roofMaterial: { kind: 'pills', options: ['Tiles', 'IBR sheeting', 'Thatch', 'Concrete', 'Slate'], other: true },
  wallMaterial: { kind: 'pills', options: ['Brick', 'Plaster', 'Wood', 'Concrete'], other: true },
  buildingMaterial: { kind: 'pills', options: ['Brick', 'Timber frame', 'Steel frame'], other: true },
  buildingAge: { kind: 'slider', min: 0, max: 100, step: 1, unit: 'years' },
  businessActivitiesDetails: { kind: 'long' },
  plansApprovedDetails: { kind: 'long' },
  entryPointOther: { kind: 'short', placeholder: 'Where did they get in?' },
  forcedEntryDetails: { kind: 'long' },
  surroundingsOther: { kind: 'short', placeholder: 'What surrounds it?' },
  driverOwnsOtherVehicle: { kind: 'yes-text', label: 'Does the driver own another vehicle?', then: 'Which insurance company, and the policy number?' },
  previousAccidents: { kind: 'yes-text', label: 'Has the driver had any other accidents before this one?', then: 'Roughly when, and what happened?', long: true },
  loadCommodity: { kind: 'short', placeholder: 'e.g. building material' },
  preExistingDamage: { kind: 'yes-text', label: 'Was there any damage on the car before this happened?', then: 'What and where?', long: true },
  licenceIssued: { kind: 'short', placeholder: 'e.g. 2015, code B' },
  driverOwnInsurance: { kind: 'yes-text', label: 'Does the driver have a car of their own that is insured?', then: 'Which insurance company, and what is the policy number?' },
  otherVehicleColour: { kind: 'pills', options: ['White', 'Silver', 'Grey', 'Black', 'Red', 'Blue'], other: true },
  otherPropertyOwner: { kind: 'short', placeholder: 'Name of the owner', bare: true },
  otherPropertyDamage: { kind: 'short', placeholder: 'What was damaged', bare: true },
  vehicleDatePurchased: { kind: 'date', month: true },
  driverDefectsDetails: { kind: 'short', placeholder: 'What is it?' },
  driverOtherCarInsurer: insurer('Which insurance company is it with?'),
  otherPropertyAddress: { kind: 'short', placeholder: 'Address of the owner', bare: true },
  accidentCause: { kind: 'long', label: 'In your view, what caused the accident? Type or record it.' },
  bloodSampleResult: pills(['Negative', 'Positive', "Don\'t know yet"], { other: true }),
  chassisNumber: { kind: 'short', placeholder: 'Chassis number from the registration papers' },
  bondholderName: combo(['ABSA', 'Capitec', 'FNB', 'Investec', 'Nedbank', 'Standard Bank'], { label: 'Which bank or lender is the bond with?', placeholder: 'Choose or type the bank' }),
  sapsNotReportedReason: pills(["I haven\'t had the chance yet", "It didn\'t seem worth reporting"], { other: true }),
};

export const FORM_CONTROLS: Readonly<Record<string, FormControl>> = {
  ...INSURER_CONTROLS,
  // ---- the generic list's general questions: what Tina's walkthrough asks on chat, filled in from it when she has
  description: { kind: 'long', label: 'What happened? Tell us in your own words.' },
  injuryDetails: { kind: 'long', label: 'Who was hurt, and how? Type or record it.' },
  incidentCause: pills(['An accident', 'Theft or burglary', 'Fire', 'Storm or flood', 'Burst pipe or geyser'], { other: true }),
  incidentAt: { kind: 'datetime', label: 'When did it happen?' },
  place: short('e.g. 12 Oak Avenue, Durbanville', { label: 'Where did it happen?' }),
  whatDamaged: multi(['Vehicle', 'House or building', 'Furniture', 'Electronics', 'Jewellery'], { other: true, label: 'What was lost or damaged?' }),
  estimatedCost: pills(['Under R5 000', 'R5 000 to R20 000', 'R20 000 to R50 000', 'R50 000 to R100 000', 'Over R100 000'], { label: 'Roughly how much to fix or replace it?' }),

  // ---- the vehicle
  vehicleMake: combo(CAR_MAKES, { placeholder: 'Choose or type the make' }),
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
  vehicleExtras: yesText('Did the car have any extras added after you bought it?', 'Which ones? e.g. mag wheels, a tow bar or a sound system. Type or record it', { long: true }),
  accessoriesStolen: multi(['Radio', 'Mag wheels', 'Tow bar', 'Spare wheel', 'Canopy'], { say: 'Anything else, or more about them? Type or record it' }),
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
  driverOwnerRelationship: pills(['Owner', 'Spouse', 'Child', 'Parent', 'Friend'], { other: true }),
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
  weather: pills(['Clear', 'Cloudy', 'Rain', 'Fog', 'Wind'], { other: true }),
  visibility: pills(['Good', 'Poor', 'Dark / night', 'Blinded by the sun']),
  roadSurface: pills(['Dry', 'Wet', 'Gravel', 'Potholes', 'Oil / diesel']),
  precautions: multi(['Braked', 'Swerved', 'Hooted', 'Nothing was possible'], { other: true }),
  additionalInfo: yesText('Is there anything else the insurer should know?', 'Please tell us', { long: true }),
  damageDescription: CAR,
  damagedParts: CAR,

  // ---- the other vehicle and the people in it
  otherVehicle: makeAndModel('What make and model was the other car?'),
  otherVehicleMake: makeAndModel('What make and model was the other car?'),
  otherRegistration: card('Registration number'),
  otherContact: card("Other driver's phone number or email"),
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
  // The user (9 Nov 2026): each row of taps says what it is, so how badly they were hurt and who they were don't run together.
  injuredDetails: pills(['Minor', 'Went to hospital'], { other: true, label: 'How badly were they hurt?' }),
  injuredRelationship: pills(['Driver', 'Passenger', 'Other driver', 'Pedestrian'], { label: 'Who were they?' }),
  witnessName: card('Name'),
  witnessFirstName: card('First name', true),
  witnessSurname: card('Surname', true),
  witnessPhone: card('Contact number'),
  witnessRelationship: pills(['Stranger', 'Family', 'Friend', 'Colleague'], { bare: true }),

  // ---- finance, tracking, keys and history
  financeInstitution: combo(FINANCE_HOUSES, { label: 'Which bank or finance company is it with?', placeholder: 'Choose or type the bank or finance company' }),
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
  incidentCountry: combo(['South Africa', 'Angola', 'Botswana', 'Eswatini', 'Lesotho', 'Malawi', 'Mauritius', 'Mozambique', 'Namibia', 'Tanzania', 'Zambia', 'Zimbabwe'], { placeholder: 'Choose or type the country' }),
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
  suspectRelationship: pills(['Stranger', 'Family', 'Neighbour', 'Domestic worker', 'Friend'], { other: true }),
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
  resultantDamageDetails: multi(['Ceilings', 'Walls', 'Floors', 'Carpets', 'Furniture'], { other: true }),
  previousInsurer: combo(['This is my first', ...INSURERS], { placeholder: 'Choose or type the insurer' }),
  previousLosses: yesText('Have you had a similar loss or claim in the last 5 years?', 'Roughly when, what happened and how much?', { long: true }),
};

/** The yes/no that a repeating group's card count answers, when the form has that group. */
export const FORM_STEPPERS: Readonly<Record<string, Extract<FormControl, { kind: 'stepper' }>>> = {
  hadPassengers: { kind: 'stepper', group: 'passengers', label: 'How many passengers were in the vehicle?', none: 'Only the driver', one: 'passenger', many: 'passengers' },
  thirdParties: { kind: 'stepper', group: 'otherParties', label: 'How many other cars or people were involved?', none: 'Nobody else', one: 'other', many: 'others' },
  injuries: { kind: 'stepper', group: 'injured', label: 'How many people were hurt?', none: 'Nobody', one: 'person', many: 'people' },
  hadWitnesses: { kind: 'stepper', group: 'witnesses', label: 'How many witnesses were there?', none: 'No witnesses', one: 'witness', many: 'witnesses' },
};

/**
 * The count of a repeating group with no yes/no in front of it: the items a client claims for. At least one, so the
 * first card shows straight away.
 */
export const FORM_COUNTERS: Readonly<Record<string, Extract<FormControl, { kind: 'stepper' }>>> = Object.fromEntries(
  ['items', 'contentsItems', 'specifiedItems', 'unspecifiedItems'].map((group) => [group, {
    kind: 'stepper', group, label: 'How many items are you claiming for?', none: 'items', one: 'item', many: 'items', min: 1,
  } as const]),
);
/** The count's key on the page. It is never saved: what it answers is the group's "is there another?" questions. */
export const counterKey = (group: string) => `${group}.count`;

/**
 * One kind of claim's own words for a question whose key another kind uses for something else: on a motor form
 * otherInsuranceDetails is the other driver's insurer, on a household form it's the client's other policy.
 */
const BY_MASTER: Partial<Record<MasterFormId, Readonly<Record<string, FormControl>>>> = {
  property: {
    otherInsuranceDetails: combo(INSURERS, { label: 'Which insurance company is it insured with?', placeholder: 'Choose or type the insurer', detail: { placeholder: 'Policy number (if you have it)', joiner: ', policy ' } }),
  },
};
const STEPPERS_BY_MASTER: Partial<Record<MasterFormId, Readonly<Record<string, Extract<FormControl, { kind: 'stepper' }>>>>> = {
  'motor-accident': {
    thirdParties: { kind: 'stepper', group: 'otherParties', label: 'How many other cars were involved?', none: 'No other cars', one: 'other car', many: 'other cars' },
  },
};
/**
 * A kind of claim's own control, where its master form's doesn't fit. A windscreen claim (the user, 9 Nov 2026) is about
 * the glass, so its damaged parts are the car's glass as taps, not the drawing of the whole car.
 */
const GLASS = ['Windscreen', 'Rear window', 'Left side windows', 'Right side windows', 'Sunroof'];
const BY_CLAIM_TYPE: Readonly<Record<string, Readonly<Record<string, FormControl>>>> = {
  Windscreen: { damagedParts: multi(GLASS, { other: true, label: 'Which glass is damaged?' }) },
};
/** The control of a question on one kind of claim's form. */
export const formControl = (master: MasterFormId, key: string, claimType?: string): FormControl | undefined =>
  (claimType ? BY_CLAIM_TYPE[claimType]?.[key] : undefined) ?? BY_MASTER[master]?.[key] ?? FORM_CONTROLS[key];
export const formStepper = (master: MasterFormId, key: string) => STEPPERS_BY_MASTER[master]?.[key] ?? FORM_STEPPERS[key];

/**
 * A line under a question that only makes sense with an example: the question's own example sentence never shows on
 * the form (formPrompt keeps the question and nothing else).
 */
const NOTES: Partial<Record<MasterFormId, Readonly<Record<string, string>>>> = {
  property: {
    otherInterest: 'For example: you still owe a bank or a store money on it, you are paying it off on credit or a lease, or it belongs partly to someone else, like your spouse or a business partner.',
    otherInsurance: 'For example: a laptop that is also covered by your work\'s insurance, or jewellery on a separate policy with another insurer.',
  },
};
export const formNote = (master: MasterFormId, key: string): string | undefined => NOTES[master]?.[key];

/**
 * What would help, under a photo or document the client may not know what to send for. Examples, never a promise of
 * what the insurer accepts. Keyed by the kind of claim, then the evidence key; `other` is the "Anything else" row.
 */
const EVIDENCE_HELP: Record<MasterFormId, Readonly<Record<string, string>>> = {
  'motor-accident': {
    scenePhotos: 'For example: both cars where they stopped, the damage on each car, the other car\'s number plate, skid marks or broken glass on the road.',
    damagePhotos: 'For example: each damaged part close up, and the whole car from each corner.',
    thirdPartyPhotos: 'For example: the other car\'s number plate, its damage, and the other driver\'s licence.',
    quotes: 'A written quote from each panelbeater, with their name and the price.',
    repairQuote: 'A written quote from a panelbeater, with their name and the price.',
    other: 'For example: dashcam or CCTV footage, photos of the road, traffic lights or road signs, or messages with the other driver.',
  },
  'motor-theft': {
    vehiclePhotos: 'For example: any recent photo that shows the car clearly, its number plate, mag wheels or stickers. Photos from your phone\'s gallery or an advert are fine.',
    damagePhotos: 'For example: each damaged part close up, broken glass or a forced lock.',
    damageReport: 'A report from the panelbeater saying what is damaged.',
    repairQuote: 'A written quote from a panelbeater, with their name and the price.',
    settlementLetter: 'Your bank or finance company can send it to you. A PDF from their app or email is fine.',
    other: 'For example: CCTV footage, photos of broken glass where the car was parked, the spare keys, or a report from the tracking company.',
  },
  property: {
    damagePhotos: 'For example: the damaged item close up and from further away, a burst geyser, water marks on the ceiling, broken glass or a forced lock.',
    quotes: 'A written quote from a shop or repairer, with their name and the price.',
    damageReport: 'For example: a letter or job card from the repairer or plumber saying what broke and why.',
    proofOfOwnership: 'For example: a till slip, the purchase on a bank statement, the box with the serial number, or a photo with the item in it.',
    other: 'For example: CCTV footage, photos of broken glass, a forced lock or window, or a report from your alarm or armed response company.',
  },
  generic: {
    damagePhotos: 'For example: the damage close up and from further away, broken glass, or a forced lock.',
    quotes: 'A written quote from a repairer or shop, with their name and the price.',
    other: 'For example: CCTV footage, photos of broken glass or damage, or a letter about what happened.',
  },
};
export const evidenceHelp = (master: MasterFormId, key: string): string | undefined => EVIDENCE_HELP[master][key];

/** Evidence the client can draw with a finger on the form, as well as add as a photo. */
export const FORM_DRAWINGS: ReadonlySet<string> = new Set(['accidentSketch']);

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
