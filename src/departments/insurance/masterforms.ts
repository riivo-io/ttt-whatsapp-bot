// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/masterforms.ts (commit 28d7572). Do not edit here:
// change the source and run scripts/sync-insurance-package.sh. Replaced by the shared package in TTTFG-4830.
// TTTFG-5562: the guided form's master forms. One per kind of claim, each holding every unique question of every go-live
// insurer form of that kind, grouped into the topics a client sees one screen at a time. The client only ever sees what
// their own insurer's form asks (guided.ts); the answers are saved against the form's own question keys, so filling the
// form, signing and the claim pack carry on as they do for a chat-answered claim.
//
// A master form holds no question text: the wording stays in the insurer form's question list (TTTFG-5172), so a changed
// form is still a setup change. It says where each question key goes, and which keys are the same question under another
// name on another insurer's form (`yearModel|vehicleYear`), which is how an answer on an earlier claim pre-fills a later
// one. test/claims-guided-master.test.ts fails when a question of a go-live form is on no master form, so a new or changed
// form can't lose a question without someone choosing its topic here.
import type { ClaimForm } from './contracts';

export type MasterFormId = 'motor-accident' | 'motor-theft' | 'property' | 'generic';

export interface MasterField {
  /** The first key names it. */
  id: string;
  /** The question's key on each insurer form that asks it: the same question, so one form never has two of them. */
  keys: readonly string[];
  /** The vehicle or property itself: an answer on the client's earlier claim pre-fills it (AC 3). */
  prefill: boolean;
}

export interface MasterTopic {
  id: string;
  /** The screen's heading. */
  title: string;
  fields: readonly MasterField[];
}

export interface MasterForm {
  id: MasterFormId;
  /** How the client's claim is named on the form. */
  title: string;
  topics: readonly MasterTopic[];
  /** The documents and photos of the kind of claim (kind `evidence`), asked on the last screen. */
  evidence: readonly MasterField[];
}

/** "a b|c": field a, and field b that is called c on another insurer's form. */
const fields = (spec: string, prefill = ''): MasterField[] => {
  const pre = new Set(prefill.split(/\s+/).filter(Boolean));
  return spec.split(/\s+/).filter(Boolean).map((f) => {
    const keys = f.split('|');
    return { id: keys[0], keys, prefill: keys.some((k) => pre.has(k)) };
  });
};
const topic = (id: string, title: string, spec: string, prefill = ''): MasterTopic => ({ id, title, fields: fields(spec, prefill) });

/** TTTFG-5562: what Tina's walkthrough asks on chat. It opens every form, and the burst pipe only shows on a home claim. */
const HAPPENED = topic('happened', 'What happened', 'incidentAt place description thirdParties injuries saps burstPipe contractor');
const POLICY = topic('policy', 'Your policy', 'ownPolicy policyholderRelationship policyDocsReceived preferredContact');
const WHERE = topic('where', 'Where it happened', 'incidentSuburb incidentProvince incidentCountry dateDiscovered');
const FINANCE_KEYS = 'vehicleFinanced financeInstitution financeAgreementType financeAccountNumber financeSettlementAmount registrationDocsAvailable';
const FINANCE = topic('finance', 'Finance on the vehicle', FINANCE_KEYS);
const AUTHORITIES = 'authoritiesAtScene authAmbulance authFireBrigade authTrafficPolice authParamedics authPolice authSecurity authTowTruck';
const WITNESSES = 'hadWitnesses witnessFirstName witnessSurname witnessPhone witnessRelationship';
const SAPS = 'sapsCaseNumber sapsStation sapsDateReported sapsReportedByClient sapsReportedBy';
const VEHICLE_NOW = 'vehicleLocationName vehicleLocationAddress vehicleLocationPhone vehicleDrivable vehicleTowed towCompany towDriver towPhone towAuthorised';
const VEHICLE_ITSELF = 'vehicleMake vehicleModel vehicleRegistration yearModel vehicleYear vehicleColour transmission vehicleOwnedByClient registeredOwner titleHolder';

export const MASTER_FORMS: Record<MasterFormId, MasterForm> = {
  'motor-accident': {
    id: 'motor-accident',
    title: 'Motor claim',
    topics: [
      HAPPENED,
      POLICY,
      topic('vehicle', 'Your vehicle',
        'vehicleMake vehicleModel vehicleRegistration yearModel kmReading transmission hasAccessories vehicleOwnedByClient registeredOwner', VEHICLE_ITSELF),
      topic('finance', FINANCE.title, `${FINANCE_KEYS} titleHolder`),
      WHERE,
      topic('driver', 'The driver',
        'driverIsClient driverName driverFirstName driverSurname driverIdNumber driverPhone driverConsent driverOccupation driverOwnerRelationship '
        + 'driverRelationship regularDriver alcohol alcoholDetails breathalyser driverPhysicalDefects'),
      topic('licence', "The driver's licence", 'licenceNumber licenceCode licenceDateIssued licenceEndorsements|licenceEndorsed'),
      topic('trip', 'The trip',
        'vehicleUse privateUseOnly tripFrom tripTo tripPurpose timeAtLocation vehicleParked'),
      topic('passengers', 'Passengers', 'hadPassengers passengersReason passengersRelationship passengerName passengerPhone passengerInjury'),
      topic('accident', 'The accident',
        'driverScenario otherScenario speedBefore speedAtCollision weather visibility roadSurface roadCondition potholeDamage precautions additionalInfo'),
      topic('scene', 'At the scene', AUTHORITIES),
      topic('other', 'The other vehicle',
        'otherPartyResponsible otherVehicle otherVehicleMake otherRegistration otherContact otherInsurer otherDamage otherInsurance otherDriverName otherDriverPhone otherDriverAddress '
        + 'otherFirstName otherSurname otherIdNumber otherPhone otherAddress otherResponsible otherGovernment otherInsured otherInsuranceDetails'),
      topic('hurt', 'Anyone hurt', 'injuredName injuredDetails injuredRelationship'),
      topic('witnesses', 'Witnesses', `${WITNESSES} witnessName`),
      topic('police', 'The police', `${SAPS} investigatingOfficer`),
      topic('damage', 'The damage', 'damagedParts glassDamaged damageDescription'),
      topic('now', 'Where the vehicle is now', `vehicleLocation hybridAssistUsed ${VEHICLE_NOW}`),
    ],
    evidence: fields('driversLicence driverId accidentSketch scenePhotos quotes damagePhotos thirdPartyPhotos repairQuote'),
  },
  'motor-theft': {
    id: 'motor-theft',
    title: 'Vehicle theft claim',
    topics: [
      HAPPENED,
      POLICY,
      topic('vehicle', 'Your vehicle',
        'vehicleMakeModel vehicleMake vehicleModel vehicleRegistration vehicleYear|yearModel vehicleMileage|kmReading vehicleColour transmission hasAccessories '
        + 'vehicleOwnedByClient registeredOwner ownerRelationship', VEHICLE_ITSELF),
      topic('recognise', 'How to recognise it',
        'vehicleMarks engineNumber vinNumber interiorColour vehicleFeatures vehicleExtras hasStickers stickersWhere stickersDescribe hasDents dentsWhere dentsDescribe '
        + 'hasScratches scratchesWhere scratchesDescribe'),
      topic('security', 'Tracking and security',
        'hasTracker trackerMake trackerCompany trackerDateFitted trackerNotifiedTime trackerType hasAlarm hasImmobiliser hasAntiHijack hasIntruderGlass hasDatadot otherSecurity'),
      FINANCE,
      topic('theft', 'When it was taken',
        'dateDiscovered careIsClient careName carePhone vehicleLocked whatStolen accessoriesStolen cctvFootage theftLocation theftLocationOther theftOutcome vehicleParked tripTo tripFrom'),
      topic('where', 'Where it happened', 'incidentSuburb incidentProvince incidentCountry'),
      topic('keys', 'The keys', 'keysWith keySets keysReplaced keysReplacedDate keysReplacedBy'),
      topic('scene', 'At the scene', AUTHORITIES),
      topic('driver', 'The driver', 'driverIsClient driverFirstName driverSurname driverIdNumber driverRelationship regularDriver'),
      topic('licence', 'Licence and use', 'licenceCode licenceEndorsed privateUseOnly vehicleUse'),
      topic('damage', 'The damage', 'damagedParts glassDamaged'),
      topic('now', 'Where the vehicle is now', VEHICLE_NOW),
      topic('witnesses', 'Witnesses', WITNESSES),
      topic('police', 'The police', SAPS),
      topic('history', "The vehicle's history", 'advertised advertisedWhere motorPlan warranty lastServiced lastServicedBy lastServicedWhere lastServicedKm'),
    ],
    evidence: fields('driversLicence settlementLetter registrationPapers vehiclePhotos damageReport repairQuote damagePhotos'),
  },
  property: {
    id: 'property',
    title: 'Household claim',
    topics: [
      HAPPENED,
      POLICY,
      topic('claim', "What you're claiming for", 'claimContents claimBuilding buildingCause portableSection lossCause lossKind'),
      topic('when', 'When and where',
        'incidentSuburb incidentProvince incidentCountry dateDiscovered premisesLeftDate premisesLeftTime whereWereYou premisesOccupied premisesLastOccupied'),
      topic('home', 'Your home',
        'buildingType buildingTypeOther premisesType occupiedFor propertyAge occupiedBy tenantName tenantPhone unoccupiedFrom unoccupiedTo clientIs',
        'buildingType buildingTypeOther premisesType propertyAge'),
      topic('items', 'What was lost or damaged',
        'itemDescription itemAge itemFrom itemDateAcquired itemPurchaseAmount itemAmountClaimed|itemValue '
        + 'contentsItem contentsFrom contentsAmount contentsAge contentsProof specifiedItem specifiedFrom specifiedAmount specifiedAge specifiedProof '
        + 'unspecifiedItem unspecifiedFrom unspecifiedAmount unspecifiedAge unspecifiedProof estimateTotal'),
      topic('phone', 'The stolen phone or tablet', 'phoneOrTablet itemBlacklisted blacklistReference'),
      topic('entry', 'How they got in',
        'forcedEntry entryPoint exitPoint enteredMainHouse enteredOtherAreas enteredOutbuilding enteredGarage enteredCottage enteredDomesticQuarters enteredShed enteredGarden '
        + 'enteredOther enteredOtherDetails stolenFromVehicle forcedEntryVehicle'),
      topic('suspects', 'Who did it', 'hasSuspects suspectFirstName suspectSurname suspectPhone suspectRelationship lossCausedByThirdParty thirdPartyName thirdPartyPhone'),
      topic('discovered', 'Who found out first',
        'theftDiscoveredByClient theftDiscovererFirstName theftDiscovererSurname theftDiscovererPhone theftDiscovererRelationship '
        + 'fireDiscoveredByClient fireDiscovererFirstName fireDiscovererSurname fireDiscovererPhone fireDiscovererRelationship'),
      topic('security', 'Security at your home',
        'hasBurglarBars hasSecurityGates hasLinkedAlarm alarmActivated alarmType hasAccessControl hasInfraredBeams hasDogs hasElectricFence otherSecurity armedResponseCompany armedResponsePhone'),
      topic('fire', 'The fire',
        'fireCauseKnown fireCause fireOriginKnown fireOrigin firePremisesLeftDate firePremisesLeftTime fireWhereWereYou fireHasArmedResponse fireArmedResponseCompany fireArmedResponsePhone'),
      topic('impact', 'What hit the property',
        'impactCause impactDriverFirstName impactDriverSurname impactDriverPhone impactVehicleRegistration impactGovernment impactDriverInsured impactDriverInsurance '
        + 'treeCutDown treeCompany treeContactFirstName treeContactSurname treeContactPhone treeFellerInsured treeFellerInsurance '
        + 'impactOwnerFirstName impactOwnerSurname impactOwnerPhone impactOwnerInsured impactOwnerInsurance'),
      topic('water', 'The water damage', 'waterSystem resultantDamage geyserType geyserTypeOther resultantDamageDetails damagedAreas'),
      topic('witnesses', 'Who saw it and who came out',
        'hadWitnesses authoritiesAtScene authFireBrigade authPolice authSecurity witnessFirstName witnessSurname witnessPhone witnessRelationship'),
      topic('police', 'The police', `${SAPS} sapsPhone`),
      topic('recovered', 'What was found', 'itemsRecovered recoveredItem recoveredLocation'),
      topic('insurance', 'Other insurance and past claims',
        'otherInterest otherInterestDetails otherInterestName otherInsurance otherInsuranceDetails coveredElsewhere previousLosses previousInsurer'),
    ],
    evidence: fields('damagePhotos quotes damageReport proofOfOwnership forcedEntryProof'),
  },
  generic: {
    id: 'generic',
    title: 'Claim',
    topics: [
      topic('what', 'What happened', 'description incidentCause burstPipe contractor'),
      topic('when', 'When and where', 'incidentAt place'),
      topic('lost', 'What was lost or damaged', 'whatDamaged estimatedCost'),
      topic('others', 'Who else was involved', 'thirdParties otherFirstName otherSurname otherPhone otherRegistration otherInsurer'),
      topic('hurt', 'Anyone hurt', 'injuries injuredName injuredDetails'),
      topic('witnesses', 'Witnesses', 'hadWitnesses witnessFirstName witnessSurname witnessPhone'),
      topic('police', 'The police', 'saps sapsCaseNumber sapsStation'),
      topic('claim', 'Anything else', 'additionalInfo'),
    ],
    evidence: fields('damagePhotos quotes otherEvidence'),
  },
};

/** The claim types of each master form. A form with no claim type (the generic row) or another type gets the generic one. */
const FAMILY: Record<string, MasterFormId> = {
  'Motor accident': 'motor-accident',
  Windscreen: 'motor-accident',
  'Motor theft': 'motor-theft',
  Hijacking: 'motor-theft',
  'Property loss or damage': 'property',
  'Portable possessions': 'property',
};

/** The master form for a claim form: the generic row is always the generic one, so it never shows a motor heading. */
export const masterFormFor = (form: Pick<ClaimForm, 'provider' | 'claimType'>): MasterForm =>
  MASTER_FORMS[form.provider && form.claimType ? FAMILY[form.claimType] ?? 'generic' : 'generic'];

/** Where a question key sits on a master form. Undefined: a question nobody has given a topic yet (guided.ts still shows it). */
export function masterPlace(master: MasterForm, key: string): { topic: MasterTopic; field: MasterField } | undefined {
  for (const t of master.topics) {
    const field = t.fields.find((f) => f.keys.includes(key));
    if (field) return { topic: t, field };
  }
  return undefined;
}

/** How many unique questions a master form holds, for the coverage report. */
export const masterQuestionCount = (master: MasterForm) => master.topics.reduce((n, t) => n + t.fields.length, 0);
