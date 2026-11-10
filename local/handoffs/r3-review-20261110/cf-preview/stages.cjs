'use strict';
const STAGES=new Set(['wrapper_entered','wrapper_prepared','guard_passed','compile_entered','compile_returned','compile_failed','cli_main_rejected','createPreviewSession_entered','initializer_request_enter','initializer_request_ok','initializer_request_fail','initializer_validated','exchange_enter','exchange_request_ok','exchange_request_fail','exchange_unavailable','exchange_token','subdomain_enter','subdomain_ok','subdomain_fail','protocol_returned']);
const NAMES=new Set(['Error','TypeError','ReferenceError','SyntaxError','RangeError','CompatibilityFailure','APIError','UserError','FatalError','AbortError']);
const CODES=new Set(['MODULE_NOT_FOUND','ERR_MODULE_NOT_FOUND','ERR_REQUIRE_ESM','ERR_INVALID_ARG_TYPE','ERR_UNKNOWN_FILE_EXTENSION','ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING','ERR_VM_MODULE_NOT_MODULE','ENOENT','EACCES','EPERM','ECONNREFUSED','ECONNRESET','ETIMEDOUT','ENOTFOUND','ABORT_ERR']);
function record(stage,error,sink=line=>process.stderr.write(line)) {
  try {
    if(!STAGES.has(stage))return;
    const fields=['LC_STAGE',stage];
    const name=error?.constructor?.name;
    if(NAMES.has(name))fields.push('kind='+name);
    const code=error?.code;
    if(typeof code==='string'&&CODES.has(code))fields.push('code='+code);
    else if(Number.isSafeInteger(code)&&code>=1000&&code<=999999)fields.push('api_code='+code);
    sink(fields.join('|')+'\n');
  }catch{} // Observation must never replace an original exception or outcome.
}
module.exports={record,STAGES,NAMES,CODES};
