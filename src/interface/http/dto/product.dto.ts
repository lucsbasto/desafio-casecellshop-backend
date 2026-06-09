import { ApiProperty } from '@nestjs/swagger';

export class ProductDto {
  @ApiProperty({ example: 'CAPA-001' })
  id!: string;

  @ApiProperty({ example: 'Capinha Silicone Preta iPhone 15' })
  name!: string;

  @ApiProperty({ example: 4990, description: 'Preço em centavos (evita float)' })
  priceCents!: number;

  @ApiProperty({ example: true })
  available!: boolean;

  @ApiProperty({ example: 25 })
  stock!: number;
}
