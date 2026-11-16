# Sourced only inside build RUN steps. BuildKit secret mounts never become image layers.
if [ -f /run/secrets/rdf_proxy ]; then
  HTTP_PROXY=$(cat /run/secrets/rdf_proxy)
  HTTPS_PROXY=$HTTP_PROXY
  http_proxy=$HTTP_PROXY
  https_proxy=$HTTP_PROXY
  export HTTP_PROXY HTTPS_PROXY http_proxy https_proxy
fi

if [ -f /run/secrets/rdf_proxy_ca ]; then
  SSL_CERT_FILE=/run/secrets/rdf_proxy_ca
  CURL_CA_BUNDLE=$SSL_CERT_FILE
  RDF_APT_CA_OPT='-o Acquire::https::CaInfo=/run/secrets/rdf_proxy_ca'
  RDF_CURL_CA_OPT='--cacert /run/secrets/rdf_proxy_ca --proxy-cacert /run/secrets/rdf_proxy_ca'
  export SSL_CERT_FILE CURL_CA_BUNDLE RDF_APT_CA_OPT RDF_CURL_CA_OPT
fi
