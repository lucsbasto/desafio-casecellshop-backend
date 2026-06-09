import { Controller, Get, Param } from '@nestjs/common';
import { ApiNotFoundResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { ListProductsUseCase } from '../../../application/use-cases/list-products.usecase';
import { ErrorDto } from '../dto/error.dto';
import { ProductDto } from '../dto/product.dto';

@ApiTags('catalog')
@Controller('products')
export class ProductsController {
  constructor(private readonly listProducts: ListProductsUseCase) {}

  @Get()
  @ApiOkResponse({ type: [ProductDto], description: 'Catálogo (servido via cache com TTL)' })
  async findAll(): Promise<ProductDto[]> {
    return this.listProducts.listAll();
  }

  @Get(':id')
  @ApiOkResponse({ type: ProductDto })
  @ApiNotFoundResponse({ type: ErrorDto })
  async findOne(@Param('id') id: string): Promise<ProductDto> {
    return this.listProducts.getById(id);
  }
}
