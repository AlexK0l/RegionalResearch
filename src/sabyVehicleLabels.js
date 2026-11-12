// Shared vehicle-model label guard for all Saby truck row readers.
// A Saby fleet card may render VIN, registration plate and other small
// metadata as separate DOM text leaves under a REAL vehicle. They must
// NEVER be counted as additional trucks. A vehicle with an unknown year
// is still a vehicle (year:null), not a reason to lose the row.
//
// Export the fixed regex source so Chromium DOM evaluators, which cannot
// close over Node module functions, use the SAME exclusions.
export const SABY_NON_VEHICLE_LABEL_PATTERN=String.raw`^(?:(?:VIN|ВИН|ГРЗ(?:\s+ТС)?|Гос\.?\s*номер|Государственный\s+регистрационный\s+(?:номер|знак)|Регистрационный\s+(?:номер|знак)|Номер\s+(?:кузова|шасси|двигателя)|ПТС|СТС)(?=\s|[:#№]|$)|(?:Автопарк|Грузовые|Легковые|Коммерческие|Автобусы|Спецтехника|Прицепы|Мотоциклы|Показать|Загрузить|Ещё|Еще|Свернуть|Всего)(?=\s|$))`;
const excluded=new RegExp(SABY_NON_VEHICLE_LABEL_PATTERN,"iu");

export function isSabyTruckVehicleLabel(input) {
  if(typeof input!=="string")return false;
  const text=input.replace(/\s+/g," ").trim();
  return text.length>=3&&text.length<=150&&
    /[a-zа-яё]/iu.test(text)&&!excluded.test(text)&&
    !/(?:\.\.\.|…)\s*$/.test(text);
}
