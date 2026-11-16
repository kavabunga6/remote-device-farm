# Sourced only inside build RUN steps. BuildKit secret mounts never become image layers.
if [ -f /run/secrets/rdf_proxy ]; then
  HTTP_PROXY=$(cat /run/secrets/rdf_proxy)
  HTTPS_PROXY=$HTTP_PROXY
  http_proxy=$HTTP_PROXY
  https_proxy=$HTTP_PROXY
  export HTTP_PROXY HTTPS_PROXY http_proxy https_proxy
fi

rdf_apt_get() {
  if [ -n "${NO_PROXY:-}" ] && [ -n "${HTTP_PROXY:-}" ]; then
    RDF_NO_PROXY=$NO_PROXY no_proxy= NO_PROXY= apt-get \
      -o Acquire::http::Proxy-Auto-Detect=/usr/local/lib/rdf-sdk/apt-proxy.sh \
      -o Acquire::https::Proxy-Auto-Detect=/usr/local/lib/rdf-sdk/apt-proxy.sh \
      ${RDF_APT_CA_OPT:-} "$@"
  else
    apt-get ${RDF_APT_CA_OPT:-} "$@"
  fi
}

if [ -f /run/secrets/rdf_no_proxy ]; then
  NO_PROXY=$(cat /run/secrets/rdf_no_proxy)
  no_proxy=$NO_PROXY
  export NO_PROXY no_proxy
fi

if [ -f /run/secrets/rdf_proxy_ca ]; then
  SSL_CERT_FILE=/run/secrets/rdf_proxy_ca
  CURL_CA_BUNDLE=$SSL_CERT_FILE
  RDF_APT_CA_OPT='-o Acquire::https::CaInfo=/run/secrets/rdf_proxy_ca'
  RDF_CURL_CA_OPT='--cacert /run/secrets/rdf_proxy_ca --proxy-cacert /run/secrets/rdf_proxy_ca'
  export SSL_CERT_FILE CURL_CA_BUNDLE RDF_APT_CA_OPT RDF_CURL_CA_OPT
fi
