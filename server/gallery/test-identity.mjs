import http from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync, randomUUID, createHash, sign } from 'node:crypto';

export async function testIdentity() { // A local signed OIDC issuer exercises the real client without a live account or external requests.
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const codes = new Map(), access = new Map();
  const control = { user: 'lidoll', claims: {}, profileSubject: null, badSignature: false, lastAuthorization: null };
  const server = http.createServer(async (request,response) => {
    const url = new URL(request.url, control.issuer);
    const json = data => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)); };
    if (url.pathname === '/.well-known/openid-configuration') return json({ issuer: control.issuer, authorization_endpoint: control.issuer+'/authorize', token_endpoint: control.issuer+'/token', userinfo_endpoint: control.issuer+'/userinfo', jwks_uri: control.issuer+'/jwks', response_types_supported:['code'], subject_types_supported:['public'], id_token_signing_alg_values_supported:['RS256'], token_endpoint_auth_methods_supported:['none'], code_challenge_methods_supported:['S256'] });
    if (url.pathname === '/jwks') return json({keys:[{...publicKey.export({format:'jwk'}),kid:'test',alg:'RS256',use:'sig'}]});
    if (url.pathname === '/authorize') {
      control.lastAuthorization = url;
      const code = randomUUID();
      codes.set(code,{params:url.searchParams,user:control.user});
      const callback = new URL(url.searchParams.get('redirect_uri'));
      callback.searchParams.set('code',code); callback.searchParams.set('state',url.searchParams.get('state'));
      response.writeHead(303,{Location:callback.href}); response.end(); return;
    }
    if (url.pathname === '/token') {
      let body=''; for await(const chunk of request) body+=chunk;
      const values=new URLSearchParams(body), entry=codes.get(values.get('code')); codes.delete(values.get('code'));
      if(!entry || values.get('grant_type')!=='authorization_code' || values.get('client_id')!==entry.params.get('client_id') || values.get('redirect_uri')!==entry.params.get('redirect_uri') || createHash('sha256').update(values.get('code_verifier')||'').digest('base64url')!==entry.params.get('code_challenge')) {response.writeHead(400,{'Content-Type':'application/json'});response.end('{"error":"invalid_grant"}');return;}
      const now=Math.floor(Date.now()/1000), bearer=randomUUID(); access.set(bearer,entry.user);
      const claims={iss:control.issuer,sub:'subject-'+entry.user,aud:entry.params.get('client_id'),nonce:entry.params.get('nonce'),iat:now,exp:now+600,...control.claims};
      const unsigned=[{alg:'RS256',kid:'test'},claims].map(value=>Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
      return json({access_token:bearer,token_type:'Bearer',expires_in:600,id_token:unsigned+'.'+(control.badSignature?Buffer.alloc(256):sign('RSA-SHA256',Buffer.from(unsigned),privateKey)).toString('base64url')});
    }
    if(url.pathname==='/userinfo') {const user=access.get(request.headers.authorization?.slice(7));if(!user){response.writeHead(401);response.end();return;}return json({sub:control.profileSubject||'subject-'+user,preferred_username:control.profileName || user});}
    response.writeHead(404);response.end();
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');control.issuer='http://127.0.0.1:'+server.address().port;
  control.close=async()=>{const closed=once(server,'close');server.close();server.closeAllConnections();await closed;};
  return control;
}
