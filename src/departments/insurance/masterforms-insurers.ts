// GENERATED COPY of ttt-preseason-agent/src/departments/insurance/masterforms-insurers.ts (commit edef23f). Do not edit here:
// change the source and run scripts/sync-insurance-package.sh. Replaced by the shared package in TTTFG-4830.
// 9 Nov 2026: the questions that the claim forms of 13 more insurers ask and the go-live forms don't, and the screen each sits on.
// The wording stays in each insurer form's question list (config/claimforms); this only says where a question key goes.
// masterforms.ts adds these to the topics it already has, and starts a topic where the id is new.
import type { MasterFormId } from './masterforms';

export interface InsurerTopic { id: string; title: string; fields: string }
/** Per master form: the keys to add to a topic (a topic id the master doesn't have yet is added, with `title`). */
export const INSURER_TOPICS: Readonly<Record<MasterFormId, readonly InsurerTopic[]>> = {
  'motor-accident': [
    { id: 'vehicle', title: "Vehicle", fields:
      'vinNumber vehiclePurchaseDate vehiclePurchasePrice engineNumber vehicleMakeModel vehicleColour vehicleMarks '
      + 'preExistingDamage vehicleDatePurchased vehicleInsuredElsewhere' },
    { id: 'damage', title: "Damage", fields:
      'oldDamage repairerName repairEstimate glassBreakType glassType glassSignwriting damageRepaired '
      + 'damageRepairedDetails glassCause smashAndGrab loadCarried loadCommodity' },
    { id: 'driver', title: "Driver", fields:
      'driverAddress driverEmployee driverOwnInsurer driverOwnPolicyNo driverPreviousAccidents driverConvictions '
      + 'driverOtherVehicle driverEmail driverOwnsOtherVehicle driverAge driverConsentDetails driverHasDefects '
      + 'driverDefectDetails principalDriver principalDriverOther previousAccidents driverOwnInsurance '
      + 'driverDefectsDetails driverOwnsOtherCar driverOtherCarInsurer bloodSampleTaken bloodSampleResult' },
    { id: 'licence', title: "Licence", fields:
      'licenceExpiry licencePlaceIssued licenceType licenceEndorsementDetails licenceIssued' },
    { id: 'passengers', title: "Passengers", fields:
      'passengersEmployees passengerAddress passengerAge passengersInjured passengersFarePaying passengerEmail' },
    { id: 'hurt', title: "Hurt", fields:
      'injuredHospital injuredAge injuredPhone injuredInCarAny injuredInCarName injuredInCarRole injuredInCarDetails '
      + 'injuredInCarHospital' },
    { id: 'other', title: "Other", fields:
      'otherColour propertyDamagedAny propertyOwner propertyDamage otherOwnerDriver otherPropertyDamaged '
      + 'damagedPropertyItem damagedPropertyOwner damagedPropertyDamage otherDriverNameAddress otherOwnerNameAddress '
      + 'otherSignwriting otherYear otherOwnerName otherOwnerAddress propertyOwnerAddress otherType otherVehicleColour '
      + 'hadOtherPropertyDamage otherPropertyOwner otherPropertyDamage otherPropertyAddress propertyOwnerName '
      + 'propertyDamageDetails' },
    { id: 'witnesses', title: "Witnesses", fields:
      'witnessAddress witnessEmail witnessLocation witnessPassenger' },
    { id: 'accident', title: "Accident", fields:
      'roadWidth vehicleLights streetLighting warningGiven streetLightsOn driverWarned roadState roadLayout roadType '
      + 'junctionType faultOpinion faultWhy warningDetails someoneResponsible responsibleDetails lostControl '
      + 'lostControlDetails tyresChanged tyresChangedWhich vehicleLightsOn accidentCause' },
    { id: 'policy', title: "Policy", fields:
      'occupation soleOwner otherInterestDetails coveredElsewhere coveredElsewhereDetails previousInsurer' },
    { id: 'property', title: "Property damaged", fields:
      '' },
    { id: 'now', title: "Now", fields:
      'assessmentLocation carHireNeeded assistLineUsed assistReference towAuthorisedBy towedBy' },
    { id: 'police', title: "Police", fields:
      'breathalyserResult sapsTimeReported sapsNumberType' },
    { id: 'trip', title: "Trip", fields:
      'tripType cctvFootage' },
    { id: 'scene', title: "Scene", fields:
      'testedOrArrested' },
    { id: 'insurance', title: "Other insurance", fields:
      'coveredElsewhereInsurer coveredElsewherePolicyNo' },
  ],
  'motor-theft': [
    { id: 'recognise', title: "Recognise", fields:
      'oldDamage hasWindowMarkings windowMarkingsNumber windowMarkingsBy vehicleHiddenMarks vehicleExtrasDetails '
      + 'vehicleHasMarks vehicleMarksDetails vehicleAlterations preExistingDamage chassisNumber' },
    { id: 'theft', title: "Theft", fields:
      'notLockedReason accessoriesInsured accessoriesInsuredSeparately vehicleNotLockedReason stolenItems '
      + 'vehicleUnlockedReason' },
    { id: 'vehicle', title: "Vehicle", fields:
      'vehiclePurchaseDate vehiclePurchasePrice vehiclePricePaid' },
    { id: 'policy', title: "Policy", fields:
      'occupation previousInsurer' },
    { id: 'security', title: "Security", fields:
      'trackerFittedBy windowMarkingNumber windowMarkingBy hasSecurityDevices securityDevices antiTheftFitted '
      + 'antiTheftMake antiTheftDateFitted antiTheftFittedBy' },
    { id: 'driver', title: "Driver", fields:
      'driverOccupation driverAddress driverName driverPhone' },
    { id: 'police', title: "Police", fields:
      'sapsTimeReported sapsNumberType investigatingOfficer' },
    { id: 'witnesses', title: "Witnesses", fields:
      'witnessName' },
    { id: 'insurance', title: "Other insurance", fields:
      'coveredElsewhere coveredElsewhereInsurer coveredElsewherePolicyNo' },
    { id: 'licence', title: "Licence", fields:
      'licenceEndorsements licenceDateIssued' },
    { id: 'damage', title: "Damage", fields:
      'damageDescription' },
    { id: 'now', title: "Now", fields:
      'vehicleLocation' },
  ],
  'property': [
    { id: 'policy', title: "Policy", fields:
      'clientOccupation occupation' },
    { id: 'when', title: "When", fields:
      'occupiedByWhom premisesOccupiedBy premisesOccupants buildingNormallyOccupied whoWasHome occupantName '
      + 'occupantPhone' },
    { id: 'suspects', title: "Suspects", fields:
      'thirdPartyAddress' },
    { id: 'insurance', title: "Other insurance", fields:
      'hadPreviousLoss previousLossDetails previousLossInsurer coveredElsewhereInsurer itemsBusinessOnly '
      + 'itemsOwnedByOther itemsOwnedByOtherDetails soleOwner' },
    { id: 'items', title: "Items", fields:
      'lastValued itemsRepaired itemsRepairedDetails' },
    { id: 'home', title: "Home", fields:
      'unitsDamaged inBodyCorporate sectionNumber unitNumber recentRepairs recentRepairsDetails roofMaterial '
      + 'wallMaterial buildingMaterial buildingAge businessActivities businessActivitiesDetails registeredBond '
      + 'financeInstitution plansApproved plansApprovedDetails hasBond bondholderName thatchRoof' },
    { id: 'claim', title: "Claim", fields:
      'incidentCause lossCauseOther' },
    { id: 'witnesses', title: "Witnesses", fields:
      'witnessName witnessAddress authAmbulance authTowTruck' },
    { id: 'water', title: "Water", fields:
      'geyserSize geyserBurst geyserRepaired geyserRepairDetails floorsDamage ceilingDamage cupboardsDamage' },
    { id: 'payment', title: "The payment", fields:
      'payeeType payeeName bankName bankBranch bankAccount' },
    { id: 'salvage', title: "Where the damaged item is", fields:
      'itemLocation itemLocationPhone' },
    { id: 'security', title: "Security", fields:
      'alarmSet alarmReportRequested burglarBarsType occupiedDuringDay housesOnThreeSides surroundings '
      + 'surroundingsOther nearInformalSettlement' },
    { id: 'entry', title: "Entry", fields:
      'vehicleLeftUnattended vehicleEntryHow vehicleMakeModel itemsPlacement entryPointOther forcedEntryDetails' },
    { id: 'fire', title: "Fire", fields:
      'fireExtinguisherServiced' },
    { id: 'discovered', title: "Discovered", fields:
      'discoveredByClient discovererName discovererIdNumber discovererPhone' },
    { id: 'police', title: "Police", fields:
      'investigatingOfficer sapsNotReportedReason' },
  ],
  'generic': [
  ],
};

/** Evidence items of each master form (kind `evidence`), asked on the last screen. */
export const INSURER_EVIDENCE: Readonly<Record<MasterFormId, string>> = {
  'motor-accident': 'potholePhotos registrationPapers',
  'motor-theft': 'trackerProof serviceInvoice accessoryInvoices antiTheftCertificate',
  'property': '',
  'generic': '',
};
