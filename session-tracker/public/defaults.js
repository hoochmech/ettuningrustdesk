// Written to the database the first time a staff member signs in and the lists are
// empty. After that the lists are edited on the Lists tab, not here.
window.DEFAULT_CATEGORIES = [
  { name: "Tune install", requires_issue: false },
  { name: "Tune revision", requires_issue: false, asks_original_file: true },
  { name: "Diagnostics", requires_issue: false },
  { name: "Datalog review", requires_issue: false },
  { name: "Warranty", requires_issue: true, asks_original_file: true },
  { name: "Support / other", requires_issue: false },
];

// `folder` is the make's top-level folder on the X: drive and `file_prefix` starts the
// IDs of the files in it (CUM-00001, ...).
window.DEFAULT_VEHICLE_MAKES = ["Chevrolet", "Dodge", "Ford", "GMC", "Ram", "Other"];

// Starter list only: check it against your own records and fix it on the Lists tab.
window.DEFAULT_ENGINES = [
  {
    name: "Cummins",
    folder: "Cummins",
    file_prefix: "CUM",
    models: [
      { name: "5.9L 24V VP44 (1998.5-2002)", ecms: ["CM550"] },
      { name: "5.9L Common Rail (2003-2007)", ecms: ["CM848"] },
      { name: "6.7L (2007.5-2012)", ecms: ["CM2100"] },
      { name: "6.7L (2013-2018)", ecms: ["CM2200"] },
      { name: "6.7L (2019+)", ecms: ["CM2350B"] },
    ],
  },
  {
    name: "Duramax",
    folder: "Duramax",
    file_prefix: "DMX",
    models: [
      { name: "LB7 (2001-2004)", ecms: ["E54"] },
      { name: "LLY (2004.5-2005)", ecms: ["E60"] },
      { name: "LBZ (2006-2007)", ecms: ["E35"] },
      { name: "LMM (2007.5-2010)", ecms: ["E35"] },
      { name: "LML (2011-2016)", ecms: ["E86"] },
      { name: "L5P (2017+)", ecms: ["E41"] },
    ],
  },
  {
    name: "Power Stroke",
    folder: "Power Stroke",
    file_prefix: "PSD",
    models: [
      { name: "6.0L (2003-2007)", ecms: ["PCM"] },
      { name: "6.4L (2008-2010)", ecms: ["PCM"] },
      { name: "6.7L (2011+)", ecms: ["PCM"] },
    ],
  },
];
