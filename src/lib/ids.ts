import { randomBytes } from 'node:crypto';

/**
 * Prefixed, time-sortable string IDs (acc_, usr_, led_ …). The first 12 hex characters encode
 * milliseconds since epoch so IDs sort by creation time; the rest is random. Internal only: people
 * see reference numbers (LD-2610-00042, CU-000318; Section 4.2).
 */
export type IdPrefix = 'adc' | 'adr' | 'plc' | 'acf' | 'var' | 'adt' | 'cnx' | 'lfm' | 'sbm' | 'cll' | 'rec' | 'sor' | 'cfc' | 'exp' | 'sgr' | 'rsb' | 'tpl' | 'wtx' | 'msg' | 'nom' | 'rnw' | 'pay' | 'prp' | 'pol' | 'cq' | 'qt' | 'rnk' | 'cor' | 'ocr' | 'prc' | 'prd' | 'pv' | 'cmr' | 'typ' | 'tpl' | 'doc' | 'dlb' | 'veh' | 'ins' | 'map' | 'fil' | 'ntf' | 'acc' | 'pip' | 'usr' | 'otp' | 'stu' | 'ses' | 'cus' | 'fam' | 'con' | 'led' | 'act' | 'tsk' | 'lnk';

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${Date.now().toString(16).padStart(12, '0')}${randomBytes(8).toString('hex')}`;
}