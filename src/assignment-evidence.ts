import type { Attributes } from "@opentelemetry/api";
import type { AssignmentEvidence } from "./types.js";

export function assignmentAttributes(evidence: AssignmentEvidence): Attributes {
  return {
    "proxy.candidate.id": evidence.candidateId,
    "proxy.assignment.mode": evidence.assignmentMode,
    "proxy.assignment.change_reason": evidence.changeReason,
    "proxy.assignment.provider_reassignment_disabled": evidence.providerManagedReassignmentDisabled,
    ...(evidence.proxySlotId === undefined ? {} : { "proxy.provider.slot_id": evidence.proxySlotId }),
    ...(evidence.previousCandidateId === undefined
      ? {}
      : {
          "proxy.candidate.previous_id": evidence.previousCandidateId,
        }),
    ...(evidence.providerSessionId === undefined
      ? {}
      : {
          "proxy.provider.session_id": evidence.providerSessionId,
        }),
    ...(evidence.peerId === undefined ? {} : { "proxy.provider.peer_id": evidence.peerId }),
    ...(evidence.deviceId === undefined ? {} : { "proxy.provider.device_id": evidence.deviceId }),
    ...(evidence.egressIp === undefined ? {} : { "proxy.egress.ip": evidence.egressIp }),
    ...(evidence.opaqueIpId === undefined ? {} : { "proxy.egress.opaque_ip_id": evidence.opaqueIpId }),
    ...(evidence.expectedCity === undefined ? {} : { "proxy.city.expected": evidence.expectedCity }),
    ...(evidence.observedCity === undefined ? {} : { "proxy.city.observed": evidence.observedCity }),
    ...(evidence.verificationSource === undefined
      ? {}
      : {
          "proxy.city.verification_source": evidence.verificationSource,
        }),
  };
}

export function assignmentLogContext(evidence: AssignmentEvidence): Record<string, unknown> {
  return {
    candidateId: evidence.candidateId,
    proxySlotId: evidence.proxySlotId,
    assignmentMode: evidence.assignmentMode,
    providerManagedReassignmentDisabled: evidence.providerManagedReassignmentDisabled,
    changeReason: evidence.changeReason,
    previousCandidateId: evidence.previousCandidateId,
    providerSessionId: evidence.providerSessionId,
    peerId: evidence.peerId,
    deviceId: evidence.deviceId,
    egressIp: evidence.egressIp,
    opaqueIpId: evidence.opaqueIpId,
    expectedCity: evidence.expectedCity,
    observedCity: evidence.observedCity,
    verificationSource: evidence.verificationSource,
  };
}
