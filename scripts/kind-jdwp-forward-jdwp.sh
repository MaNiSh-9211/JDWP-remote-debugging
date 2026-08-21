#!/usr/bin/env bash
# JDWP: pod A -> localhost:5005, pod B -> localhost:5006 (run in two terminals or background).
set -euo pipefail
NS=jdwp-demo
POD_A=$(kubectl get pod -n "$NS" -l app=jdwp-demo-a -o jsonpath='{.items[0].metadata.name}')
POD_B=$(kubectl get pod -n "$NS" -l app=jdwp-demo-b -o jsonpath='{.items[0].metadata.name}')
if [[ -z "$POD_A" || -z "$POD_B" ]]; then
  echo "Pods not found in $NS. Apply k8s/kind-jdwp-demo/install.yaml" >&2
  exit 1
fi
echo "Pod A: $POD_A -> localhost:5005"
echo "Pod B: $POD_B -> localhost:5006"
echo "Run in two terminals:"
echo "  kubectl -n $NS port-forward pod/$POD_A 5005:5005"
echo "  kubectl -n $NS port-forward pod/$POD_B 5006:5005"
