#!/usr/bin/env bash
# Provision the Oracle Always Free resume-parsing server with the OCI CLI.
#
#   infra/oracle/provision.sh            # create (or find) everything, print the IP
#
# Idempotent: every resource is looked up by display name before it is created,
# so re-running after a partial failure (A1 "Out of host capacity" is common)
# picks up where it stopped. Needs ~/.oci/config (see README.md).
#
# Network posture: the only ingress rule is SSH from the Recrutas VPS. The model
# listens on 127.0.0.1; the VPS reaches it over an SSH tunnel.
set -euo pipefail

VPS_IP="${VPS_IP:-178.156.193.183}"
NAME="${NAME:-recrutas-llm}"
OCPUS="${OCPUS:-2}"          # the whole Always Free A1 allowance (2 OCPU / 12 GB)
MEMORY_GB="${MEMORY_GB:-12}"
BOOT_GB="${BOOT_GB:-50}"     # of the 200 GB Always Free block storage
SSH_KEYS="${SSH_KEYS:-$HOME/.ssh/recrutas_cron.pub $HOME/.ssh/recrutas_oracle.pub}"
HERE="$(cd "$(dirname "$0")" && pwd)"

oci() { command oci "$@"; }
# Query helper: prints the value, or nothing for an empty result. Any API error
# (e.g. a 401 while a new key propagates) aborts, rather than reading as "not
# found" and creating a duplicate resource.
q() {
  local out
  if ! out="$(oci "$@" --raw-output 2>/tmp/oci-q.err)"; then
    echo "OCI call failed: oci $*" >&2; cat /tmp/oci-q.err >&2; exit 1
  fi
  [ "$out" = "null" ] && out=""
  printf '%s' "$out"
}

TENANCY="$(awk -F= '/^tenancy/{gsub(/ /,"",$2);print $2;exit}' ~/.oci/config)"
COMPARTMENT="${COMPARTMENT:-$TENANCY}"
echo "compartment: $COMPARTMENT"

# ── Network ────────────────────────────────────────────────────────────────
VCN="$(q network vcn list -c "$COMPARTMENT" --display-name "$NAME-vcn" --query 'data[0].id')"
if [ -z "$VCN" ]; then
  VCN="$(q network vcn create -c "$COMPARTMENT" --display-name "$NAME-vcn" --cidr-blocks '["10.20.0.0/16"]' --wait-for-state AVAILABLE --query 'data.id')"
fi
echo "vcn: $VCN"

IGW="$(q network internet-gateway list -c "$COMPARTMENT" --vcn-id "$VCN" --display-name "$NAME-igw" --query 'data[0].id')"
if [ -z "$IGW" ]; then
  IGW="$(q network internet-gateway create -c "$COMPARTMENT" --vcn-id "$VCN" --display-name "$NAME-igw" --is-enabled true --wait-for-state AVAILABLE --query 'data.id')"
fi

RT="$(q network vcn get --vcn-id "$VCN" --query 'data."default-route-table-id"')"
oci network route-table update --rt-id "$RT" --force \
  --route-rules "[{\"destination\":\"0.0.0.0/0\",\"destinationType\":\"CIDR_BLOCK\",\"networkEntityId\":\"$IGW\"}]" >/dev/null

SL="$(q network security-list list -c "$COMPARTMENT" --vcn-id "$VCN" --display-name "$NAME-sl" --query 'data[0].id')"
INGRESS="[{\"protocol\":\"6\",\"source\":\"$VPS_IP/32\",\"tcpOptions\":{\"destinationPortRange\":{\"min\":22,\"max\":22}},\"description\":\"SSH from the Recrutas VPS only\"}]"
EGRESS='[{"protocol":"all","destination":"0.0.0.0/0"}]'
if [ -z "$SL" ]; then
  SL="$(q network security-list create -c "$COMPARTMENT" --vcn-id "$VCN" --display-name "$NAME-sl" \
    --ingress-security-rules "$INGRESS" --egress-security-rules "$EGRESS" --wait-for-state AVAILABLE --query 'data.id')"
else
  oci network security-list update --security-list-id "$SL" --force \
    --ingress-security-rules "$INGRESS" --egress-security-rules "$EGRESS" >/dev/null
fi

SUBNET="$(q network subnet list -c "$COMPARTMENT" --vcn-id "$VCN" --display-name "$NAME-subnet" --query 'data[0].id')"
if [ -z "$SUBNET" ]; then
  SUBNET="$(q network subnet create -c "$COMPARTMENT" --vcn-id "$VCN" --display-name "$NAME-subnet" --cidr-block 10.20.1.0/24 \
    --route-table-id "$RT" --security-list-ids "[\"$SL\"]" --wait-for-state AVAILABLE --query 'data.id')"
fi
echo "subnet: $SUBNET"

# ── Instance ───────────────────────────────────────────────────────────────
INSTANCE="$(q compute instance list -c "$COMPARTMENT" --display-name "$NAME" --lifecycle-state RUNNING --query 'data[0].id')"
if [ -z "$INSTANCE" ]; then
  IMAGE="$(q compute image list -c "$COMPARTMENT" --operating-system "Canonical Ubuntu" --operating-system-version "24.04" \
    --shape VM.Standard.A1.Flex --sort-by TIMECREATED --sort-order DESC --query 'data[0].id')"
  [ -n "$IMAGE" ] || { echo "No Ubuntu 24.04 ARM image found"; exit 1; }
  KEYFILE="$(mktemp)"; trap 'rm -f "$KEYFILE"' EXIT
  for k in $SSH_KEYS; do cat "$k"; done > "$KEYFILE"

  # A1 capacity comes and goes per availability domain; try each.
  for AD in $(q iam availability-domain list -c "$TENANCY" --query 'data[].name | join(`" "`, @)'); do
    echo "launching in $AD …"
    if INSTANCE="$(oci compute instance launch -c "$COMPARTMENT" --availability-domain "$AD" --display-name "$NAME" \
        --shape VM.Standard.A1.Flex --shape-config "{\"ocpus\":$OCPUS,\"memoryInGBs\":$MEMORY_GB}" \
        --image-id "$IMAGE" --boot-volume-size-in-gbs "$BOOT_GB" --subnet-id "$SUBNET" --assign-public-ip true \
        --ssh-authorized-keys-file "$KEYFILE" --user-data-file "$HERE/cloud-init.yaml" \
        --wait-for-state RUNNING --query 'data.id' --raw-output 2>/tmp/oci-launch.err)"; then
      break
    fi
    grep -qi "out of host capacity\|OutOfCapacity" /tmp/oci-launch.err && { echo "  no A1 capacity in $AD"; INSTANCE=""; continue; }
    cat /tmp/oci-launch.err; exit 1
  done
  [ -n "$INSTANCE" ] || { echo "No A1 capacity in any availability domain right now; re-run later."; exit 2; }
fi

IP="$(q compute instance list-vnics --instance-id "$INSTANCE" --query 'data[0]."public-ip"')"
echo "instance: $INSTANCE"
echo "public ip: $IP"
