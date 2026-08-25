import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { PaginationDto } from "../common/dto/pagination.dto";
import { VaultInitializedGuard } from "../common/guards/vault-initialized.guard";
import { RefPipe } from "../common/pipes/ref.pipe";
import { AddressesService, type DpmAttestation } from "./addresses.service";
import { toAddressResponse, type AddressResponseDto } from "./dto/address-response.dto";
import { CreateAddressDto } from "./dto/create-address.dto";
import { DpmRegisteredDto } from "./dto/dpm-registered.dto";

@ApiTags("addresses")
@UseGuards(VaultInitializedGuard)
@Controller("addresses")
export class AddressesController {
  constructor(private readonly addresses: AddressesService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async create(@Body() body: CreateAddressDto): Promise<AddressResponseDto> {
    return toAddressResponse(await this.addresses.create(body.ref));
  }

  @Get()
  async list(@Query() query: PaginationDto) {
    const page = await this.addresses.list(query.limit, query.offset);
    return {
      addresses: page.wallets.map(toAddressResponse),
      total: page.total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  @Get(":ref")
  async get(@Param("ref", RefPipe) ref: string): Promise<AddressResponseDto> {
    return toAddressResponse(await this.addresses.get(ref));
  }

  /**
   * The operator cannot register the address with the DPM platform without proof that this
   * vault controls it, and the private key never leaves here — so the signature is handed
   * over instead. The operator then posts it to the platform through the gateway.
   */
  @Post(":ref/dpm-attestation")
  @HttpCode(HttpStatus.OK)
  signDpmAttestation(@Param("ref", RefPipe) ref: string): Promise<DpmAttestation> {
    return this.addresses.signDpmAttestation(ref);
  }

  /**
   * Not in the original spec, which describes `wallets.dpm_registered` without giving the
   * operator a way to set it. Meta-transaction signing gates on the flag, so the gateway
   * needs this call after the DPM platform confirms registration.
   */
  @Post(":ref/dpm-registered")
  @HttpCode(HttpStatus.OK)
  async setDpmRegistered(
    @Param("ref", RefPipe) ref: string,
    @Body() body: DpmRegisteredDto,
  ): Promise<AddressResponseDto> {
    return toAddressResponse(await this.addresses.setDpmRegistered(ref, body.registered));
  }
}
