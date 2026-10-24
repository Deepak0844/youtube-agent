import { describe, expect, it } from "vitest";
import { type AddressClass, classifyAddress, DOCKER_RANGES, isPublicAddress } from "@/server/core/net-policy";

const cases: [string, AddressClass][] = [
  ["8.8.8.8", "public"],
  ["10.0.0.1", "private"],
  ["172.16.5.4", "private"],
  ["192.168.1.1", "private"],
  ["127.0.0.1", "loopback"],
  ["::1", "loopback"],
  ["169.254.169.254", "metadata"],
  ["fd00:ec2::254", "metadata"],
  ["169.254.1.1", "linklocal"],
  ["fe80::1", "linklocal"],
  ["100.64.0.1", "cgnat"],
  ["100.127.255.255", "cgnat"],
  ["172.17.0.2", "docker"],
  ["224.0.0.1", "multicast"],
  ["ff02::1", "multicast"],
  ["0.0.0.0", "reserved"],
  ["240.0.0.1", "reserved"],
  ["fc00::1", "private"],
  ["fd12::1", "private"],
  ["::ffff:10.0.0.1", "private"],
  ["::ffff:8.8.8.8", "public"],
  ["2001:4860:4860::8888", "public"],
  ["not-an-ip", "invalid"],
  ["999.1.1.1", "invalid"],
  ["", "invalid"],
  ["2130706433", "loopback"],
  ["0x7f.0.0.1", "loopback"],
  ["017700000001", "loopback"],
  ["127.1", "loopback"],
];

describe("classifyAddress", () => {
  it.each(cases)("%s -> %s", (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });
});

describe("isPublicAddress", () => {
  it("is true only for public", () => {
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("10.0.0.1")).toBe(false);
    expect(isPublicAddress("nope")).toBe(false);
  });
});

describe("DOCKER_RANGES", () => {
  it("lists the docker/orbstack CIDRs", () => {
    expect(DOCKER_RANGES).toEqual(["172.17.0.0/16", "192.168.215.0/24", "192.168.228.0/23", "198.19.248.0/21"]);
  });
});
